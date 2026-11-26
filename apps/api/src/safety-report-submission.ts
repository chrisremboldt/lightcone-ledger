import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  LinkSafetyReportSchema,
  SAFETY_REPORT_BODY_LIMIT,
  SafetyReportLinkIssueSchema,
  SafetyReportLinkParamsSchema,
  SafetyReportReceiptQuerySchema,
  SignedInSafetyReportSchema,
  type LinkSafetyReport,
  type SafetyReportLinkIssue,
  type SafetyReportReceiptQuery,
  type SignedInSafetyReport,
} from '@ledger/contracts';
import {
  countLinkReport,
  issueReportLink,
  listReportLinks,
  reportingChannelId,
  reportLinkForToken,
  revokeReportLink,
  safetyReportStatus,
  submitSafetyReport,
  type SubmittedReport,
} from '@ledger/domain';
import {
  DomainError,
  idempotent,
  withScope,
  type AuthContext,
  type ObjectStore,
  type Pool,
  type PoolClient,
} from '@ledger/persistence';

/** Routes that take no sign-in: a reporting link's submission and a receipt check. */
export const UNAUTHENTICATED_REPORT_PATHS: readonly string[] = [
  '/v1/safety-reports/receipt',
  '/v1/safety-report-links/submissions',
];
/** Requests whose log line keeps no address, port or user agent: the report page and every submission route. */
export const UNATTRIBUTED_PATHS: ReadonlySet<string> = new Set([
  '/report',
  '/v1/safety-reports',
  ...UNAUTHENTICATED_REPORT_PATHS,
]);
const AT_ONCE = 4;
/** The reporter is given the receipt code alone: never the record's id. */
const codeOnly = async (receipt: Promise<{ code: string }>) => ({ code: (await receipt).code });
const noStore = { 'Cache-Control': 'private, no-store' };

function submitted(
  report: SignedInSafetyReport | LinkSafetyReport,
  channel: SubmittedReport['channel'],
): SubmittedReport {
  return {
    narrative: report.whatWasSeen.trim(),
    ...(report.occurredAt ? { occurredAt: report.occurredAt } : {}),
    ...(report.where?.trim() ? { siteReference: report.where.trim() } : {}),
    ...(report.contact?.trim() ? { contact: report.contact.trim() } : {}),
    channel,
  };
}

export function registerSafetyReportRoutes(
  app: FastifyInstance,
  dependencies: {
    pool: Pool;
    store: ObjectStore;
    principal: (request: FastifyRequest) => AuthContext;
    key: (request: FastifyRequest) => string;
  },
): void {
  const { pool, store, principal, key } = dependencies;
  let running = 0;
  // Bounds the requests that record no person, without keeping anything about who sends them.
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (running >= AT_ONCE)
      throw new DomainError(429, 'safety_reports_busy', 'Ledger is taking other reports right now; try again shortly');
    running++;
    try {
      return await operation();
    } finally {
      running--;
    }
  };
  /**
   * A report sent with a key the reporter's device made: the key is kept under the reporting channel, never the person,
   * with a digest of the key and the report together, so the row cannot confirm a guess at what a report says. A repeat
   * records nothing; the receipt code was shown once and cannot be shown again.
   */
  const onceForKey = async (client: PoolClient, channel: AuthContext, sent: string, report: SubmittedReport) => {
    const accepted = await idempotent(
      client,
      channel,
      '/v1/safety-reports',
      sent,
      { key: sent, report },
      async () => {
        const receipt = await submitSafetyReport(client, channel, report, store);
        return { id: receipt.recordId, value: { code: receipt.code } };
      },
      async () => {
        throw new DomainError(
          409,
          'safety_report_already_received',
          'This report was already received. Its receipt code was shown when it was received and cannot be shown again.',
        );
      },
    );
    return accepted.value;
  };
  /** Runs as the organization's reporting channel; the person who sent the report is never part of it. */
  const asChannel = <T>(tenantId: string, operation: (client: PoolClient, channel: AuthContext) => Promise<T>) =>
    withScope(pool, { id: reportingChannelId(tenantId), tenantId }, operation);

  app.post<{ Body: SignedInSafetyReport }>(
    '/v1/safety-reports',
    { schema: { body: SignedInSafetyReportSchema }, bodyLimit: SAFETY_REPORT_BODY_LIMIT },
    async (request, reply) => {
      const person = principal(request);
      if (person.kind !== 'human')
        throw new DomainError(403, 'person_required', 'A safety report is submitted by a person');
      const report: SubmittedReport = {
        ...submitted(request.body, 'submitted_signed_in'),
        ...(request.body.writtenAt ? { writtenAt: request.body.writtenAt } : {}),
        ...(request.body.named ? { reporterName: person.name } : {}),
      };
      const sent = key(request);
      const receipt = await bounded(() =>
        asChannel(person.tenantId, (client, channel) =>
          sent
            ? onceForKey(client, channel, sent, report)
            : codeOnly(submitSafetyReport(client, channel, report, store)),
        ),
      );
      return reply.code(201).headers(noStore).send({ receipt });
    },
  );

  app.post<{ Body: LinkSafetyReport }>(
    '/v1/safety-report-links/submissions',
    { schema: { body: LinkSafetyReportSchema }, bodyLimit: SAFETY_REPORT_BODY_LIMIT },
    async (request, reply) => {
      const receipt = await bounded(async () => {
        const link = await reportLinkForToken(pool, request.body.token);
        return asChannel(link.tenantId, async (client, channel) => {
          await countLinkReport(client, channel, link.linkId);
          return codeOnly(submitSafetyReport(client, channel, submitted(request.body, 'submitted_link'), store));
        });
      });
      return reply.code(201).headers(noStore).send({ receipt });
    },
  );

  app.post<{ Body: SafetyReportReceiptQuery }>(
    '/v1/safety-reports/receipt',
    { schema: { body: SafetyReportReceiptQuerySchema }, bodyLimit: SAFETY_REPORT_BODY_LIMIT },
    async (request, reply) => {
      const status = await bounded(() => safetyReportStatus(pool, request.body.code));
      return reply.headers(noStore).send(status);
    },
  );

  app.get('/v1/sms/report-links', async (request, reply) => {
    const links = await withScope(pool, principal(request), listReportLinks, undefined, true);
    return reply.headers(noStore).send(links);
  });

  app.post<{ Body: SafetyReportLinkIssue }>(
    '/v1/sms/report-links',
    { schema: { body: SafetyReportLinkIssueSchema } },
    async (request, reply) => {
      const issued = await withScope(pool, principal(request), async (client, who) => {
        const accepted = await idempotent(
          client,
          who,
          '/v1/sms/report-links',
          key(request),
          request.body,
          async () => {
            const value = await issueReportLink(client, who, request.body);
            return { id: value.link.id, value };
          },
          async () => {
            // The token exists only in the first response; a retry cannot be shown it again.
            throw new DomainError(
              409,
              'report_link_token_not_repeated',
              'This reporting link was already issued and its link was shown once. Revoke it and issue another.',
            );
          },
        );
        return accepted.value;
      });
      return reply.code(201).headers(noStore).send(issued);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/sms/report-links/:id/revoke',
    { schema: { params: SafetyReportLinkParamsSchema } },
    async (request, reply) => {
      const revoked = await withScope(pool, principal(request), (client, who) =>
        revokeReportLink(client, who, request.params.id),
      );
      return reply.headers(noStore).send(revoked);
    },
  );
}
