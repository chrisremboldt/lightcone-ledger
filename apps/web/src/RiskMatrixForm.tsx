import { useState, type FormEvent } from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import {
  riskAcceptanceValues,
  type Principal,
  type RiskAcceptance,
  type RiskMatrixBody,
  type SmsBasis,
  type SmsRecordDetailResponse,
} from '@ledger/contracts';
import { Button, Notice } from '@ledger/ui';
import { FailureNotice, useCommand } from './SmsForms.js';
import {
  cellLevel,
  matrixDraftProblems,
  MAX_LEVELS,
  MIN_LEVELS,
  trimmedMatrix,
  withAddedLevel,
  withCellLevel,
  withoutLevel,
} from './risk-matrix-draft.js';
import { acceptanceLabels } from './sms-labels.js';

type Axis = 'severities' | 'likelihoods';

function AxisFields({
  axis,
  legend,
  noun,
  draft,
  onChange,
}: {
  axis: Axis;
  legend: string;
  noun: string;
  draft: RiskMatrixBody;
  onChange: (draft: RiskMatrixBody) => void;
}) {
  const set = (index: number, field: 'label' | 'description', value: string) =>
    onChange({
      ...draft,
      [axis]: draft[axis].map((entry, at) => (at === index ? { ...entry, [field]: value } : entry)),
    });
  return (
    <fieldset className="sms-matrix-axis">
      <legend>{legend}</legend>
      {draft[axis].map((entry, index) => (
        <div key={entry.id} className="sms-matrix-axis-row">
          <label>
            {`${noun} ${index + 1}`}
            <input value={entry.label} maxLength={80} onChange={(event) => set(index, 'label', event.target.value)} />
          </label>
          <label>
            {`${noun} ${index + 1} definition`}
            <textarea
              rows={2}
              value={entry.description}
              maxLength={400}
              onChange={(event) => set(index, 'description', event.target.value)}
            />
          </label>
        </div>
      ))}
    </fieldset>
  );
}

function LevelFields({ draft, onChange }: { draft: RiskMatrixBody; onChange: (draft: RiskMatrixBody) => void }) {
  const set = (id: string, field: 'label' | 'meaning' | 'acceptance', value: string) =>
    onChange({
      ...draft,
      levels: draft.levels.map((level) => (level.id === id ? { ...level, [field]: value } : level)),
    });
  return (
    <fieldset className="sms-matrix-axis">
      <legend>Levels, least to most serious</legend>
      <p className="safety-form-note">
        Your own levels, {MIN_LEVELS} to {MAX_LEVELS} of them. A risk at a level is accepted by a person whose authority
        covers it: the low, medium or high risk acceptance granted on the People screen, a higher one covering the
        lower. A level nobody may accept cannot be accepted by anyone. A later level needs at least the authority of the
        one before it.
      </p>
      {draft.levels.map((level, index) => (
        <div key={level.id} className="sms-matrix-axis-row">
          <label>
            {`Level ${index + 1} name`}
            <input
              value={level.label}
              maxLength={40}
              onChange={(event) => set(level.id, 'label', event.target.value)}
            />
          </label>
          <label>
            {`What level ${index + 1} means`}
            <textarea
              rows={2}
              value={level.meaning}
              maxLength={400}
              onChange={(event) => set(level.id, 'meaning', event.target.value)}
            />
          </label>
          <label>
            {`Who may accept level ${index + 1}`}
            <select
              value={level.acceptance}
              onChange={(event) => set(level.id, 'acceptance', event.target.value as RiskAcceptance)}
            >
              {riskAcceptanceValues.map((acceptance) => (
                <option key={acceptance} value={acceptance}>
                  {acceptanceLabels[acceptance]}
                </option>
              ))}
            </select>
          </label>
          {draft.levels.length > MIN_LEVELS && (
            <Button kind="quiet" type="button" onClick={() => onChange(withoutLevel(draft, level.id))}>
              {`Remove level ${index + 1}`}
            </Button>
          )}
        </div>
      ))}
      {draft.levels.length < MAX_LEVELS && (
        <Button kind="quiet" type="button" onClick={() => onChange(withAddedLevel(draft))}>
          Add a level
        </Button>
      )}
    </fieldset>
  );
}

function CellFields({ draft, onChange }: { draft: RiskMatrixBody; onChange: (draft: RiskMatrixBody) => void }) {
  const likelihoods = [...draft.likelihoods].reverse();
  return (
    <fieldset className="sms-matrix-axis">
      <legend>Level each cell needs</legend>
      <table className="sms-matrix sms-matrix-edit">
        <thead>
          <tr>
            <th scope="col">Likelihood \ Severity</th>
            {draft.severities.map((severity) => (
              <th scope="col" key={severity.id}>
                {severity.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {likelihoods.map((likelihood) => (
            <tr key={likelihood.id}>
              <th scope="row">{likelihood.label}</th>
              {draft.severities.map((severity) => {
                const level = cellLevel(draft, severity.id, likelihood.id);
                const acceptance = draft.levels.find((entry) => entry.id === level)?.acceptance ?? 'low';
                return (
                  <td key={severity.id} className={`sms-cell sms-cell--${acceptance}`}>
                    <select
                      aria-label={`Level for ${severity.label} severity and ${likelihood.label} likelihood`}
                      value={level && draft.levels.some((entry) => entry.id === level) ? level : ''}
                      onChange={(event) =>
                        onChange(withCellLevel(draft, severity.id, likelihood.id, event.target.value))
                      }
                    >
                      {!draft.levels.some((entry) => entry.id === level) && <option value="">Choose</option>}
                      {draft.levels.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.label || entry.id}
                        </option>
                      ))}
                    </select>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </fieldset>
  );
}

/**
 * Drafts a risk matrix, or a new version of one, from a whole 5 × 5 definition. A new matrix starts from the standard
 * form; a revision starts from the current version. Either is a draft until a person with adoption authority signs it.
 */
export function RiskMatrixForm({
  client,
  principal,
  start,
  revising,
  onRecorded,
  onCancel,
}: {
  client: LedgerClient;
  principal: Principal;
  start: RiskMatrixBody;
  /** The matrix record to record a new version of; absent for a new matrix. */
  revising?: SmsRecordDetailResponse;
  onRecorded: (id: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<RiskMatrixBody>(start);
  const [basis] = useState<SmsBasis | undefined>(revising?.basis);
  const [tried, setTried] = useState(false);
  const command = useCommand(client);
  const problems = matrixDraftProblems(draft);
  const changed = Boolean(revising && basis && revising.basis.revision !== basis.revision);
  if (!principal.capabilities.includes('sms:configure'))
    return (
      <Notice tone="neutral" title="Risk matrix">
        Drafting a risk matrix needs permission to configure safety records.
      </Notice>
    );
  async function save(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (problems.length) return;
    const body = trimmedMatrix(draft);
    const record = {
      kind: 'risk_matrix' as const,
      schema: 'sms.risk-matrix.1' as const,
      title: body.name,
      ownerId: revising?.record.owner.id ?? principal.id,
      ...(revising?.current.dueAt ? { dueAt: revising.current.dueAt } : {}),
      ...(revising?.links.length
        ? { links: revising.links.map(({ relation, target }) => ({ relation, target })) }
        : {}),
      body,
    };
    const result = await command.submit(
      revising && basis
        ? { kind: 'sms.record.revise', recordId: revising.record.id, expectedRevision: basis.revision, record }
        : { kind: 'sms.record.open', record },
    );
    const id = revising?.record.id ?? result?.command.subject?.id;
    if (result && id) onRecorded(id);
  }
  return (
    <form
      className="action-form safety-form sms-matrix-form"
      onSubmit={(event) => void save(event)}
      aria-label={revising ? 'Revise the risk matrix' : 'Draft a risk matrix'}
      noValidate
    >
      <h3>{revising ? 'Revise the risk matrix' : 'Draft a risk matrix'}</h3>
      <p className="safety-form-note">
        {revising
          ? `Saving records version ${revising.record.versionNumber + 1} as a draft. The version in force stays in force until a person with adoption authority signs this one.`
          : 'Starts from the standard 5 × 5 form with three levels. Rename it, edit each severity and likelihood, your own levels and who may accept each, and the level of each cell, then save it as a draft. It is in force only once a person with adoption authority signs it.'}
      </p>
      {changed && (
        <Notice title="Changed since you started">
          This matrix changed after you opened the form. Saving will be refused until you review it; your draft is kept.
        </Notice>
      )}
      <label htmlFor="matrix-name">Matrix name</label>
      <input
        id="matrix-name"
        value={draft.name}
        maxLength={120}
        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
      />
      <AxisFields
        axis="severities"
        legend="Severity, least to most severe"
        noun="Severity"
        draft={draft}
        onChange={setDraft}
      />
      <AxisFields
        axis="likelihoods"
        legend="Likelihood, least to most likely"
        noun="Likelihood"
        draft={draft}
        onChange={setDraft}
      />
      <LevelFields draft={draft} onChange={setDraft} />
      <CellFields draft={draft} onChange={setDraft} />
      {tried && problems.length > 0 && (
        <Notice tone="alert" title="Not saved yet">
          <ul data-testid="matrix-problems">
            {problems.map((problem) => (
              <li key={problem.field + problem.message}>{problem.message}</li>
            ))}
          </ul>
        </Notice>
      )}
      <FailureNotice failure={command.failure} />
      <div className="sms-rail-buttons">
        <Button kind="primary" type="submit" disabled={command.pending}>
          {command.pending
            ? 'Saving…'
            : revising
              ? `Save version ${revising.record.versionNumber + 1} as a draft`
              : 'Save the draft matrix'}
        </Button>
        <Button kind="quiet" type="button" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
