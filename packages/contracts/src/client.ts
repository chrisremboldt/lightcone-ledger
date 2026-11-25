import type { DevelopmentTokenResponse } from './development-tokens.js';
import type {
  ControlIndicatorRecord,
  ControlIndicatorResultListResponse,
  ControlIndicatorResultResponse,
  ControlIndicatorReview,
  ControlIndicatorReviewResponse,
} from './control-indicator-results.js';
import type {
  ControlWindowIndicatorResponse,
  ControlWindowListResponse,
  ControlWindowQuery,
} from './control-windows.js';
import type {
  Command,
  ObservationListResponse,
  ObservationQuery,
  ExportCreate,
  ExportListResponse,
  ExportResponse,
  ExportRecord,
  FlightCreate,
  FlightQuery,
  FlightWatchEvent,
  FlightWatchMessage,
  Input,
  TelemetryResponse,
  TelemetryQuery,
  UploadCreate,
  Upload,
  TimelineQuery,
  OrderQuery,
  ReceiptQuery,
  FindingsResponse,
  InvestigationRequest,
  InvestigationResponse,
  FlightPredepartureResponse,
  FlightPredepartureProgress,
  FlightPredepartureProgressResponse,
  RulePackVersionResponse,
  RulePackListResponse,
  RuleEvaluationListResponse,
  SubjectFindingListResponse,
  SubjectRecordQuery,
  OrganizationCoverageResponse,
  OrganizationDecisionsResponse,
  OrganizationPeopleQuery,
  OrganizationPeopleResponse,
  AuthorityPrincipalResponse,
  PrincipalAuthorityListQuery,
  PrincipalAuthorityListResponse,
  CredentialListResponse,
  RolePresetListResponse,
  SubjectExportCreate,
  SubjectExportResponse,
  SubjectExportListResponse,
  DecisionPacketCreate,
  DecisionPacketQuery,
  DecisionPacketResponse,
  DecisionPacketListResponse,
  DecisionPacketRecord,
  FindingPacketCreate,
  FindingPacketListResponse,
  FindingPacketQuery,
  FindingPacketResponse,
  FlightRuleSelectionResponse,
  FlightRuleSelectionRecordResponse,
  AcceptedAreaControlResponse,
  FlightMissionResponse,
  FlightMissionRevisionResponse,
  MissionAvoidanceResponse,
  MissionRouteSuggestionRequest,
  MissionRouteSuggestionResponse,
  MissionReleaseRecordResponse,
  MissionReleaseValidityResponse,
  MissionReleaseFindingsResponse,
  FlightControlsResponse,
  MissionBriefingRecordResponse,
  MissionBriefingAcknowledgementsResponse,
  CommandLinkBaselineRecordResponse,
  MonitoringWindowRecordResponse,
  SimulationAvoidanceDemoPrepare,
  SimulationAvoidanceDemoProgress,
  SimulationAvoidanceDemoProgressResponse,
  SimulationAvoidanceDemoCycleResponse,
  SimulationAvoidanceDemoListResponse,
  SimulationAvoidanceDemoControlQuery,
  SimulationAvoidanceDemoQuery,
  SimulationAvoidanceDemoPreparationQuery,
  SimulationAvoidanceDemoPreparationContext,
  HazardMonitoringHistoryQuery,
  HazardMonitoringHistoryResponse,
} from './index.js';
import type {
  AdoptionRuleCoverageResponse,
  RuleCoverageSubjectsQuery,
  RuleCoverageSubjectsResponse,
  SubjectsOnRecordQuery,
  SubjectsOnRecordResponse,
} from './rule-coverage.js';
import type { DocumentPurposesResponse } from './rule-packs.js';
import type { RecordkeepingPlanDraftResponse, RequiredRecordsResponse } from './required-records.js';
import type {
  FlightsOnRecordResponse,
  OpenFindingGroupsQuery,
  OpenFindingGroupsResponse,
  OpenFindingsQuery,
  OpenFindingsResponse,
} from './open-findings.js';
import type { paths } from './generated/api.js';
import { parseEventStream } from './event-stream.js';
export type ApiPaths = paths;
type FlightListResponse = paths['/v1/flights']['get']['responses'][200]['content']['application/json'];
type FlightResponse = paths['/v1/flights']['post']['responses'][201]['content']['application/json'];
type TimelineResponse = paths['/v1/flights/{id}/timeline']['get']['responses'][200]['content']['application/json'];
type OrderListResponse = paths['/v1/orders']['get']['responses'][200]['content']['application/json'];
type ReceiptResponse = paths['/v1/receipts/{id}']['get']['responses'][200]['content']['application/json'];
type ReceiptListResponse = paths['/v1/receipts']['get']['responses'][200]['content']['application/json'];
type UploadResponse = paths['/v1/uploads']['post']['responses'][201]['content']['application/json'];
type ArtifactResponse = paths['/v1/uploads/{id}/finalize']['post']['responses'][201]['content']['application/json'];
type CommandResponse = paths['/v1/commands']['post']['responses'][201]['content']['application/json'];

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`Ledger API returned ${status}`);
  }
}
export const MAX_PUBLIC_READ_BYTES = 2 * 1024 * 1024;
export interface BoundedReadOptions {
  maxBytes: number;
  signal?: AbortSignal;
}

function publicReadError(status: number, code: string, message: string): ApiError {
  return new ApiError(status, { error: { code, message } });
}

function publicReadUrl(baseUrl: string, path: string): string {
  const invalid = () =>
    publicReadError(400, 'public_read_path_invalid', 'Bounded reads require a relative /v1 API path.');
  if (typeof path !== 'string' || !/^\/v1(?:\/|\?|$)/.test(path) || /[\s\\#]/.test(path)) throw invalid();
  for (const segment of path.split('?')[0]!.split('/')) {
    let decoded = segment;
    for (let depth = 0; depth < 8; depth++) {
      if (decoded === '.' || decoded === '..' || /[\\/\u0000-\u001f\u007f]/.test(decoded)) throw invalid();
      if (!/%[a-f0-9]{2}/i.test(decoded)) break;
      try {
        decoded = decodeURIComponent(decoded);
      } catch {
        throw invalid();
      }
      if (depth === 7) throw invalid();
    }
  }
  if (!baseUrl || baseUrl === '/') return path;
  try {
    const base = new URL(baseUrl);
    if (
      !['http:', 'https:'].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname !== '/'
    )
      throw invalid();
    const url = new URL(path, base);
    if (url.origin !== base.origin || !/^\/v1(?:\/|$)/.test(url.pathname)) throw invalid();
    return url.href;
  } catch {
    throw invalid();
  }
}

async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) void operation.catch(() => {});
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

async function publicReadBody(response: Response, options: BoundedReadOptions): Promise<Uint8Array> {
  const { maxBytes, signal } = options;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => {
    const closing = reader ? reader.cancel(signal?.reason) : response.body?.cancel(signal?.reason);
    void closing?.catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared))))
      throw publicReadError(502, 'public_read_length_invalid', 'The API returned an invalid response length.');
    if (declared !== null && Number(declared) > maxBytes)
      throw publicReadError(413, 'public_read_too_large', 'The API response exceeds this read’s byte limit.');
    if (!response.body) return new Uint8Array();
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      signal?.throwIfAborted();
      if (done) break;
      if (value.byteLength > maxBytes - length)
        throw publicReadError(413, 'public_read_too_large', 'The API response exceeds this read’s byte limit.');
      chunks.push(value);
      length += value.byteLength;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    signal?.removeEventListener('abort', cancel);
    cancel();
    reader?.releaseLock();
  }
}

function queryString(query?: object): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query ?? {})) if (value !== undefined) params.set(name, String(value));
  return params.size ? `?${params}` : '';
}
export class LedgerClient {
  constructor(
    public baseUrl: string,
    private token: string | (() => string | null | Promise<string | null>),
    private fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}
  async readJson<T>(path: string, options: BoundedReadOptions): Promise<T> {
    const bytes = await this.boundedRead(path, options, 'application/json');
    options.signal?.throwIfAborted();
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T;
    } catch {
      throw publicReadError(502, 'public_read_invalid_json', 'The API returned invalid UTF-8 JSON.');
    }
  }
  readBytes(path: string, options: BoundedReadOptions): Promise<Uint8Array> {
    return this.boundedRead(path, options, 'application/octet-stream');
  }
  private async boundedRead(path: string, options: BoundedReadOptions, accept: string): Promise<Uint8Array> {
    const url = publicReadUrl(this.baseUrl, path);
    if (
      !options ||
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 1 ||
      options.maxBytes > MAX_PUBLIC_READ_BYTES
    )
      throw publicReadError(400, 'public_read_limit_invalid', 'Bounded reads require a byte limit from 1 to 2097152.');
    options.signal?.throwIfAborted();
    const token = await abortable(
      Promise.resolve(typeof this.token === 'function' ? this.token() : this.token),
      options.signal,
    );
    options.signal?.throwIfAborted();
    const requested = this.fetcher(url, {
      method: 'GET',
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), accept },
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: options.signal,
    }).then((response) => {
      if (options.signal?.aborted) {
        void response.body?.cancel().catch(() => {});
        options.signal.throwIfAborted();
      }
      return response;
    });
    const response = await abortable(requested, options.signal);
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      void response.body?.cancel().catch(() => {});
      throw publicReadError(502, 'public_read_redirect', 'Bounded API reads do not follow redirects.');
    }
    const bytes = await publicReadBody(response, options);
    options.signal?.throwIfAborted();
    if (!response.ok) {
      const text = new TextDecoder().decode(bytes);
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {}
      throw new ApiError(response.status, body);
    }
    return bytes;
  }
  async request<T>(path: string, init: RequestInit = {}, key?: string): Promise<T> {
    const token = typeof this.token === 'function' ? await this.token() : this.token;
    const headers = new Headers(init.headers);
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (key) headers.set('idempotency-key', key);
    if (typeof init.body === 'string' && !headers.has('content-type')) headers.set('content-type', 'application/json');
    const response = await this.fetcher(`${this.baseUrl.replace(/\/$/, '')}${path}`, { ...init, headers });
    const body = response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text();
    if (!response.ok) throw new ApiError(response.status, body);
    return body as T;
  }
  flights(query?: FlightQuery) {
    return this.request<FlightListResponse>(`/v1/flights${queryString(query)}`);
  }
  orders(query?: OrderQuery) {
    return this.request<OrderListResponse>(`/v1/orders${queryString(query)}`);
  }
  receipts(query?: ReceiptQuery) {
    return this.request<ReceiptListResponse>(`/v1/receipts${queryString(query)}`);
  }
  timeline(id: string, query?: TimelineQuery) {
    return this.request<TimelineResponse>(`/v1/flights/${encodeURIComponent(id)}/timeline${queryString(query)}`);
  }
  findings(id: string) {
    return this.request<FindingsResponse>(`/v1/flights/${encodeURIComponent(id)}/findings`);
  }
  investigateFinding(
    flightId: string,
    findingId: string,
    input: InvestigationRequest,
    signal?: AbortSignal,
  ): Promise<InvestigationResponse> {
    return this.request<InvestigationResponse>(
      `/v1/flights/${encodeURIComponent(flightId)}/findings/${encodeURIComponent(findingId)}/investigation`,
      { method: 'POST', body: JSON.stringify(input), signal },
    );
  }
  flightMission(id: string) {
    return this.request<FlightMissionResponse>(`/v1/flights/${encodeURIComponent(id)}/mission`);
  }
  commandLinkBaseline(flightId: string, baselineId: string) {
    return this.request<CommandLinkBaselineRecordResponse>(
      `/v1/flights/${encodeURIComponent(flightId)}/command-link-baselines/${encodeURIComponent(baselineId)}`,
    );
  }
  monitoringWindow(monitoringId: string) {
    return this.request<MonitoringWindowRecordResponse>(
      `/v1/organization/monitoring-windows/${encodeURIComponent(monitoringId)}`,
    );
  }
  hazardMonitoringWindows(id: string, query: HazardMonitoringHistoryQuery) {
    return this.request<HazardMonitoringHistoryResponse>(
      `/v1/hazards/${encodeURIComponent(id)}/monitoring-windows${queryString(query)}`,
    );
  }
  controlWindows(query: ControlWindowQuery) {
    return this.request<ControlWindowListResponse>(`/v1/control-windows${queryString(query)}`);
  }
  controlWindowIndicator(windowId: string, indicator: { id: string; version: number }) {
    return this.request<ControlWindowIndicatorResponse>(
      `/v1/control-windows/${encodeURIComponent(windowId)}/indicators/${encodeURIComponent(indicator.id)}/versions/${indicator.version}`,
    );
  }
  controlIndicatorResults(windowId: string) {
    return this.request<ControlIndicatorResultListResponse>(
      `/v1/control-windows/${encodeURIComponent(windowId)}/indicator-results`,
    );
  }
  recordControlIndicatorResult(windowId: string, body: ControlIndicatorRecord, key: string) {
    return this.request<ControlIndicatorResultResponse>(
      `/v1/control-windows/${encodeURIComponent(windowId)}/indicator-results`,
      { method: 'POST', body: JSON.stringify(body), headers: { 'idempotency-key': key } },
    );
  }
  reviewControlIndicatorResult(body: ControlIndicatorReview, key: string) {
    return this.request<ControlIndicatorReviewResponse>('/v1/control-indicator-reviews', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'idempotency-key': key },
    });
  }
  organizationPeople(query: OrganizationPeopleQuery = {}) {
    return this.request<OrganizationPeopleResponse>(`/v1/organization/people${queryString(query)}`);
  }
  prepareSimulationAvoidanceDemo(hazardId: string, body: SimulationAvoidanceDemoPrepare, key: string) {
    return this.request<SimulationAvoidanceDemoCycleResponse>(
      `/v1/hazards/${encodeURIComponent(hazardId)}/avoidance-demos`,
      { method: 'POST', body: JSON.stringify(body) },
      key,
    );
  }
  hazardSimulationAvoidanceDemos(hazardId: string, query: SimulationAvoidanceDemoControlQuery) {
    return this.request<SimulationAvoidanceDemoListResponse>(
      `/v1/hazards/${encodeURIComponent(hazardId)}/avoidance-demos${queryString(query)}`,
    );
  }
  flightPredeparture(flightId: string) {
    return this.request<FlightPredepartureResponse>(`/v1/flights/${encodeURIComponent(flightId)}/predeparture`);
  }
  recordFlightPredepartureProgress(flightId: string, body: FlightPredepartureProgress, key: string) {
    return this.request<FlightPredepartureProgressResponse>(
      `/v1/flights/${encodeURIComponent(flightId)}/predeparture/progress`,
      { method: 'POST', body: JSON.stringify(body) },
      key,
    );
  }
  simulationAvoidanceDemoRequests(query: SimulationAvoidanceDemoQuery = {}) {
    return this.request<SimulationAvoidanceDemoListResponse>(
      `/v1/simulation/avoidance-demos/requests${queryString(query)}`,
    );
  }
  simulationAvoidanceDemo(cycleId: string) {
    return this.request<SimulationAvoidanceDemoCycleResponse>(
      `/v1/simulation/avoidance-demos/${encodeURIComponent(cycleId)}`,
    );
  }
  simulationAvoidanceDemoPreparationContext(cycleId: string, body: SimulationAvoidanceDemoPreparationQuery) {
    return this.request<SimulationAvoidanceDemoPreparationContext>(
      `/v1/simulation/avoidance-demos/${encodeURIComponent(cycleId)}/preparation-context`,
      { method: 'POST', body: JSON.stringify(body) },
    );
  }
  recordSimulationAvoidanceDemoProgress(cycleId: string, body: SimulationAvoidanceDemoProgress, key: string) {
    return this.request<SimulationAvoidanceDemoProgressResponse>(
      `/v1/simulation/avoidance-demos/${encodeURIComponent(cycleId)}/progress`,
      { method: 'POST', body: JSON.stringify(body) },
      key,
    );
  }
  principalAuthorities(query: PrincipalAuthorityListQuery = {}) {
    return this.request<PrincipalAuthorityListResponse>(`/v1/authority/principals${queryString(query)}`, {
      cache: 'no-store',
    });
  }
  credentials() {
    return this.request<CredentialListResponse>('/v1/authority/credentials', { cache: 'no-store' });
  }
  rolePresets() {
    return this.request<RolePresetListResponse>('/v1/authority/presets');
  }
  /**
   * A new development token for a person, shown only in this response; it replaces their earlier tokens. A note, the
   * reason it is issued, is kept with the issue.
   */
  issueDevelopmentToken(principalId: string, note?: string) {
    return this.request<DevelopmentTokenResponse>(
      `/v1/authority/principals/${encodeURIComponent(principalId)}/development-token`,
      { method: 'POST', cache: 'no-store', ...(note ? { body: JSON.stringify({ note }) } : {}) },
    );
  }
  principalAuthority(id: string) {
    return this.request<AuthorityPrincipalResponse>(`/v1/authority/principals/${encodeURIComponent(id)}`, {
      cache: 'no-store',
    });
  }
  flightMissionRevision(id: string, revision: number) {
    return this.request<FlightMissionRevisionResponse>(
      `/v1/flights/${encodeURIComponent(id)}/mission/revisions/${encodeURIComponent(revision)}`,
    );
  }
  missionAvoidance(id: string) {
    return this.request<MissionAvoidanceResponse>(`/v1/flights/${encodeURIComponent(id)}/mission-avoidance`);
  }
  missionRouteSuggestion(id: string, body: MissionRouteSuggestionRequest) {
    return this.request<MissionRouteSuggestionResponse>(
      `/v1/flights/${encodeURIComponent(id)}/mission/route-suggestion`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    );
  }
  missionRelease(id: string, releaseId: string) {
    return this.request<MissionReleaseRecordResponse>(
      `/v1/flights/${encodeURIComponent(id)}/mission-releases/${encodeURIComponent(releaseId)}`,
    );
  }
  missionReleaseFindings(id: string) {
    return this.request<MissionReleaseFindingsResponse>(
      `/v1/flights/${encodeURIComponent(id)}/mission-release-findings`,
    );
  }
  flightControls(id: string) {
    return this.request<FlightControlsResponse>(`/v1/flights/${encodeURIComponent(id)}/controls`);
  }
  missionReleaseValidity(id: string, releaseId: string) {
    return this.request<MissionReleaseValidityResponse>(
      `/v1/flights/${encodeURIComponent(id)}/mission-releases/${encodeURIComponent(releaseId)}/validity`,
    );
  }
  missionBriefing(flightId: string, briefingId: string) {
    return this.request<MissionBriefingRecordResponse>(
      `/v1/flights/${encodeURIComponent(flightId)}/briefings/${encodeURIComponent(briefingId)}`,
    );
  }
  missionBriefingAcknowledgements(flightId: string, briefingId: string) {
    return this.request<MissionBriefingAcknowledgementsResponse>(
      `/v1/flights/${encodeURIComponent(flightId)}/briefings/${encodeURIComponent(briefingId)}/acknowledgements`,
    );
  }
  ruleSelection(id: string) {
    return this.request<FlightRuleSelectionResponse>(`/v1/flights/${encodeURIComponent(id)}/rule-selection`);
  }
  ruleSelectionRecord(flightId: string, selectionId: string) {
    return this.request<FlightRuleSelectionRecordResponse>(
      `/v1/flights/${encodeURIComponent(flightId)}/rule-selections/${encodeURIComponent(selectionId)}`,
    );
  }
  rulePacks() {
    return this.request<RulePackListResponse>('/v1/rule-packs');
  }
  /** Evaluations of adopted rules recorded for any one subject reference, newest first. */
  ruleEvaluations(query: SubjectRecordQuery) {
    return this.request<RuleEvaluationListResponse>(`/v1/evaluations${queryString(query)}`);
  }
  /** Findings the generic evaluator opened for any one subject reference, newest first. */
  subjectFindings(query: SubjectRecordQuery) {
    return this.request<SubjectFindingListResponse>(`/v1/findings${queryString(query)}`);
  }
  rulePackVersion(packId: string, version: number) {
    return this.request<RulePackVersionResponse>(
      `/v1/rule-packs/${encodeURIComponent(packId)}/versions/${encodeURIComponent(version)}`,
    );
  }
  /** Accepted observations of one type about one subject, as GET /v1/observations reads them. */
  observations(query: ObservationQuery) {
    return this.request<ObservationListResponse>(`/v1/observations${queryString(query)}`);
  }
  organizationCoverage() {
    return this.request<OrganizationCoverageResponse>('/v1/organization/coverage');
  }
  /** Each rule of one adoption with its population counted by latest result. */
  adoptionRuleCoverage(adoptionId: string) {
    return this.request<AdoptionRuleCoverageResponse>(
      `/v1/organization/coverage/adoptions/${encodeURIComponent(adoptionId)}`,
    );
  }
  /** The members of one rule's population behind one count, a page at a time. */
  ruleCoverageSubjects(adoptionId: string, leafId: string, query: RuleCoverageSubjectsQuery = {}) {
    return this.request<RuleCoverageSubjectsResponse>(
      `/v1/organization/coverage/adoptions/${encodeURIComponent(adoptionId)}/rules/${encodeURIComponent(leafId)}/subjects${queryString(query)}`,
    );
  }
  /** Subjects of one kind on record, with names, for picking one. */
  /** The open findings across every subject, one tab and page at a time. */
  openFindings(query: OpenFindingsQuery = {}) {
    return this.request<OpenFindingsResponse>(`/v1/organization/open-findings${queryString(query)}`);
  }
  openFindingGroups(query: OpenFindingGroupsQuery = {}) {
    return this.request<OpenFindingGroupsResponse>(`/v1/organization/open-findings/groups${queryString(query)}`);
  }
  /** The flights the organization's own flight plan records give, for an organization without an order source. */
  flightsOnRecord() {
    return this.request<FlightsOnRecordResponse>('/v1/organization/flights-on-record');
  }
  subjectsOnRecord(query: SubjectsOnRecordQuery) {
    return this.request<SubjectsOnRecordResponse>(`/v1/organization/subjects${queryString(query)}`);
  }
  /** The document purposes the organization's adopted packs declare. */
  documentPurposes() {
    return this.request<DocumentPurposesResponse>('/v1/organization/document-purposes');
  }
  /** The records the adopted packs require, with what is on file for each. */
  requiredRecords() {
    return this.request<RequiredRecordsResponse>('/v1/organization/required-records');
  }
  /** A recordkeeping plan drafted from the required records read now; records nothing. */
  recordkeepingPlanDraft() {
    return this.request<RecordkeepingPlanDraftResponse>('/v1/organization/recordkeeping-plan/draft');
  }
  organizationDecisions() {
    return this.request<OrganizationDecisionsResponse>('/v1/organization/decisions');
  }
  acceptedAreaControl(hazardId: string, controlId: string, version: number) {
    return this.request<AcceptedAreaControlResponse>(
      `/v1/area-controls/${encodeURIComponent(hazardId)}/${encodeURIComponent(controlId)}/versions/${encodeURIComponent(version)}`,
    );
  }
  createSubjectExport(body: SubjectExportCreate, key: string) {
    return this.request<SubjectExportResponse>(
      '/v1/subject-exports',
      { method: 'POST', body: JSON.stringify(body) },
      key,
    );
  }
  subjectExports(query?: { decisionId?: string }) {
    return this.request<SubjectExportListResponse>(`/v1/subject-exports${queryString(query)}`);
  }
  subjectExport(id: string) {
    return this.request<SubjectExportResponse>(`/v1/subject-exports/${encodeURIComponent(id)}`);
  }
  async subjectExportContent(id: string): Promise<Uint8Array> {
    const token = typeof this.token === 'function' ? await this.token() : this.token;
    const response = await this.fetcher(
      `${this.baseUrl.replace(/\/$/, '')}/v1/subject-exports/${encodeURIComponent(id)}/content`,
      { headers: token ? { authorization: `Bearer ${token}` } : {} },
    );
    if (!response.ok) throw new ApiError(response.status, await response.text());
    return new Uint8Array(await response.arrayBuffer());
  }
  createDecisionPacket(body: DecisionPacketCreate, key: string) {
    return this.request<DecisionPacketResponse>(
      '/v1/decision-packets',
      { method: 'POST', body: JSON.stringify(body) },
      key,
    );
  }
  decisionPackets(query?: DecisionPacketQuery) {
    return this.request<DecisionPacketListResponse>(`/v1/decision-packets${queryString(query)}`);
  }
  decisionPacket(id: string) {
    return this.request<DecisionPacketResponse>(`/v1/decision-packets/${encodeURIComponent(id)}`);
  }
  async decisionPacketContent(id: string): Promise<Uint8Array> {
    return (await this.decisionPacketDownload(id)).bytes;
  }
  async decisionPacketDownload(id: string): Promise<{ format: DecisionPacketRecord['format']; bytes: Uint8Array }> {
    const token = typeof this.token === 'function' ? await this.token() : this.token;
    const response = await this.fetcher(
      `${this.baseUrl.replace(/\/$/, '')}/v1/decision-packets/${encodeURIComponent(id)}/content`,
      { headers: token ? { authorization: `Bearer ${token}` } : {} },
    );
    if (!response.ok) throw new ApiError(response.status, await response.text());
    const format = response.headers.get('x-evidence-format');
    if (format !== 'ledger.decision-packet.1' && format !== 'ledger.decision-packet.2')
      throw new ApiError(502, {
        error: { code: 'unsupported_decision_packet_format', message: 'Expected a supported decision packet format' },
      });
    return { format, bytes: new Uint8Array(await response.arrayBuffer()) };
  }
  createFindingPacket(body: FindingPacketCreate, key: string) {
    return this.request<FindingPacketResponse>(
      '/v1/finding-packets',
      { method: 'POST', body: JSON.stringify(body) },
      key,
    );
  }
  findingPackets(query: FindingPacketQuery) {
    return this.request<FindingPacketListResponse>(`/v1/finding-packets${queryString(query)}`);
  }
  findingPacket(id: string) {
    return this.request<FindingPacketResponse>(`/v1/finding-packets/${encodeURIComponent(id)}`);
  }
  async findingPacketContent(id: string): Promise<Uint8Array> {
    const token = typeof this.token === 'function' ? await this.token() : this.token;
    const response = await this.fetcher(
      `${this.baseUrl.replace(/\/$/, '')}/v1/finding-packets/${encodeURIComponent(id)}/content`,
      { headers: token ? { authorization: `Bearer ${token}` } : {} },
    );
    if (!response.ok) throw new ApiError(response.status, await response.text());
    return new Uint8Array(await response.arrayBuffer());
  }
  async ruleSourceContent(sourceId: string): Promise<Uint8Array> {
    const token = typeof this.token === 'function' ? await this.token() : this.token;
    const response = await this.fetcher(
      `${this.baseUrl.replace(/\/$/, '')}/v1/rule-sources/${encodeURIComponent(sourceId)}/content`,
      { headers: token ? { authorization: `Bearer ${token}` } : {} },
    );
    if (!response.ok) throw new ApiError(response.status, await response.text());
    return new Uint8Array(await response.arrayBuffer());
  }
  telemetry(id: string, query: TelemetryQuery = {}) {
    return this.request<TelemetryResponse>(`/v1/flights/${encodeURIComponent(id)}/telemetry${queryString(query)}`);
  }
  async *watchFlight(
    id: string,
    options: { cursor?: string; signal?: AbortSignal; onOpen?: () => void } = {},
  ): AsyncGenerator<FlightWatchEvent> {
    const token = typeof this.token === 'function' ? await this.token() : this.token;
    const headers = new Headers({ accept: 'text/event-stream' });
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (options.cursor) headers.set('last-event-id', options.cursor);
    const response = await this.fetcher(
      `${this.baseUrl.replace(/\/$/, '')}/v1/flights/${encodeURIComponent(id)}/watch`,
      { headers, signal: options.signal, cache: 'no-store' },
    );
    if (!response.ok) throw new ApiError(response.status, await response.text());
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream'))
      throw new ApiError(502, { error: { code: 'invalid_live_response', message: 'Expected a live event stream' } });
    options.onOpen?.();
    for await (const frame of parseEventStream(response.body)) {
      if (!['telemetry.updated', 'flight.updated', 'resync_required', 'stream.closed'].includes(frame.event)) continue;
      const value: unknown = JSON.parse(frame.data);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid live notification');
      const data = value as Record<string, unknown>;
      if (data.type !== frame.event || data.flightId !== id)
        throw new Error('Live notification does not match the selected flight');
      if (data.type === 'telemetry.updated' || data.type === 'flight.updated') {
        if (
          !Number.isSafeInteger(data.revision) ||
          Number(data.revision) < 0 ||
          typeof data.cursor !== 'string' ||
          data.cursor.length > 2048 ||
          typeof data.eventId !== 'string' ||
          data.eventId.length > 200
        )
          throw new Error('Invalid live update identifiers');
      } else {
        const reasons =
          data.type === 'resync_required'
            ? ['expired_cursor', 'backlog', 'slow_client', 'scope_changed']
            : ['authentication_expired', 'access_revoked', 'shutdown'];
        if (!reasons.includes(String(data.reason))) throw new Error('Invalid live recovery reason');
      }
      yield {
        ...(frame.id !== undefined ? { id: frame.id } : {}),
        event: frame.event as FlightWatchMessage['type'],
        data: data as unknown as FlightWatchMessage,
      };
    }
  }
  receipt(id: string) {
    return this.request<ReceiptResponse>(`/v1/receipts/${encodeURIComponent(id)}`);
  }
  createFlight(body: FlightCreate, key: string) {
    return this.request<FlightResponse>('/v1/flights', { method: 'POST', body: JSON.stringify(body) }, key);
  }
  input(body: Input, key: string) {
    return this.request<ReceiptResponse>('/v1/inputs', { method: 'POST', body: JSON.stringify(body) }, key);
  }
  command(body: Command, key: string) {
    return this.request<CommandResponse>('/v1/commands', { method: 'POST', body: JSON.stringify(body) }, key);
  }
  createExport(body: ExportCreate, key: string) {
    return this.request<ExportResponse>('/v1/exports', { method: 'POST', body: JSON.stringify(body) }, key);
  }
  exports(query?: { flightId?: string; decisionId?: string }) {
    const params = new URLSearchParams();
    if (query?.flightId) params.set('flightId', query.flightId);
    if (query?.decisionId) params.set('decisionId', query.decisionId);
    return this.request<ExportListResponse>(`/v1/exports${params.size ? `?${params}` : ''}`);
  }
  export(id: string) {
    return this.request<ExportResponse>(`/v1/exports/${encodeURIComponent(id)}`);
  }
  async exportContent(id: string): Promise<Uint8Array> {
    const token = typeof this.token === 'function' ? await this.token() : this.token;
    const response = await this.fetcher(
      `${this.baseUrl.replace(/\/$/, '')}/v1/exports/${encodeURIComponent(id)}/content`,
      { headers: token ? { authorization: `Bearer ${token}` } : {} },
    );
    if (!response.ok) throw new ApiError(response.status, await response.text());
    return new Uint8Array(await response.arrayBuffer());
  }
  async exportDownload(id: string): Promise<{ format: ExportRecord['format']; bytes: Uint8Array }> {
    const token = typeof this.token === 'function' ? await this.token() : this.token;
    const response = await this.fetcher(
      `${this.baseUrl.replace(/\/$/, '')}/v1/exports/${encodeURIComponent(id)}/content`,
      { headers: token ? { authorization: `Bearer ${token}` } : {} },
    );
    if (!response.ok) throw new ApiError(response.status, await response.text());
    const format = response.headers.get('x-evidence-format');
    if (format !== 'ledger.decision-evidence.1' && format !== 'ledger.flight-evidence.2')
      throw new ApiError(502, {
        error: { code: 'unsupported_evidence_format', message: 'Expected a supported flight export format' },
      });
    return { format, bytes: new Uint8Array(await response.arrayBuffer()) };
  }
  createUpload(body: UploadCreate, key: string) {
    return this.request<UploadResponse>('/v1/uploads', { method: 'POST', body: JSON.stringify(body) }, key);
  }
  async upload(
    bytes: Uint8Array,
    contentType: string,
    key: string,
    filename?: string,
    confidentiality?: UploadCreate['confidentiality'],
  ) {
    const content = Uint8Array.from(bytes);
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', content.buffer))]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
    let { upload } = await this.createUpload(
      { byteLength: content.byteLength, contentType, filename, ...(confidentiality ? { confidentiality } : {}) },
      `${key}:create`,
    );
    const id = upload.id;
    const verify = (retained: Upload) => {
      if (
        !id ||
        retained.id !== id ||
        retained.byteLength !== content.byteLength ||
        retained.contentType !== contentType ||
        (retained.sha256 !== undefined && retained.sha256 !== sha256)
      )
        throw new ApiError(409, {
          error: {
            code: 'upload_content_conflict',
            message: 'Retained upload does not match these exact bytes and content type.',
          },
        });
      if (
        !['pending', 'stored', 'finalized'].includes(retained.status) ||
        (retained.status !== 'pending' && retained.sha256 !== sha256) ||
        (retained.status === 'finalized' && !retained.artifactId)
      )
        throw new ApiError(502, {
          error: { code: 'upload_integrity_unconfirmed', message: 'Retained upload content cannot be confirmed.' },
        });
    };
    verify(upload);
    if (upload.status === 'pending') {
      ({ upload } = await this.request<UploadResponse>(
        `/v1/uploads/${encodeURIComponent(id)}/content`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
          body: content as unknown as BodyInit,
        },
        `${key}:bytes`,
      ));
      verify(upload);
      if (upload.status === 'pending')
        throw new ApiError(502, {
          error: { code: 'upload_integrity_unconfirmed', message: 'Upload bytes remain pending.' },
        });
    }
    const result = await this.request<ArtifactResponse>(
      `/v1/uploads/${encodeURIComponent(upload.id)}/finalize`,
      { method: 'POST' },
      `${key}:finalize`,
    );
    const { artifact } = result;
    if (
      !artifact?.id ||
      (upload.artifactId && artifact.id !== upload.artifactId) ||
      artifact.uploadId !== id ||
      artifact.sha256 !== sha256 ||
      artifact.byteLength !== content.byteLength ||
      artifact.contentType !== contentType
    )
      throw new ApiError(502, {
        error: { code: 'upload_artifact_mismatch', message: 'Final artifact does not match the exact upload content.' },
      });
    return result;
  }
  async download(path: string): Promise<{ bytes: Uint8Array; headers: Headers }> {
    const token = typeof this.token === 'function' ? await this.token() : this.token;
    const response = await this.fetcher(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
      const type = response.headers.get('content-type') ?? '';
      throw new ApiError(response.status, type.includes('json') ? await response.json() : await response.text());
    }
    return { bytes: new Uint8Array(await response.arrayBuffer()), headers: response.headers };
  }
  async evidence(id: string): Promise<Uint8Array> {
    const token = typeof this.token === 'function' ? await this.token() : this.token;
    const response = await this.fetcher(
      `${this.baseUrl.replace(/\/$/, '')}/v1/artifacts/${encodeURIComponent(id)}/content`,
      { headers: token ? { authorization: `Bearer ${token}` } : {} },
    );
    if (!response.ok) throw new ApiError(response.status, await response.text());
    return new Uint8Array(await response.arrayBuffer());
  }
}
