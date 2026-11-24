import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { observationSubjectKindValues } from '@ledger/contracts';
import type {
  AdoptionRuleCoverageResponse,
  CoverageResult,
  NamedSubject,
  RuleCoverageSubjectsResponse,
  SubjectsOnRecordResponse,
} from '@ledger/contracts';
import type { LedgerClient } from '@ledger/contracts/client';
import { Button, Notice, Spinner } from '@ledger/ui';
import { coverageReadDelayMs, readsCoverageAgain } from './coverage-read.js';
import { errorMessage } from './format.js';
import { readFailureOutcome, readFailureStep } from './read-failure.js';
import {
  checkedByLabels,
  completeness,
  coverageResultLabels,
  emptyPopulationHint,
  missingWords,
  populationWords,
  sectionWords,
  shownCounts,
} from './rule-coverage.js';
import { SubjectFindings } from './SubjectFindings.js';
import { subjectLabel } from './subject-label.js';

/**
 * One adoption's rules with their members counted by latest result. A count opens the subjects behind it; a subject
 * opens its findings. Reads again while a count is still being evaluated, and after a failed read, as the coverage
 * pane does.
 */
export function RuleCoverageTable({ client, adoptionId }: { client: LedgerClient; adoptionId: string }) {
  const [shown, setShown] = useState<AdoptionRuleCoverageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [chosen, setChosen] = useState<{ leafId: string; result: CoverageResult } | null>(null);
  const failedInARow = useRef(0);
  const refresh = useCallback(() => setReload((value) => value + 1), []);
  useEffect(() => {
    let current = true;
    let later: ReturnType<typeof setTimeout> | undefined;
    client.adoptionRuleCoverage(adoptionId).then(
      (response) => {
        if (!current) return;
        failedInARow.current = 0;
        setShown(response);
        setError(null);
        if (response.rules.some((rule) => rule.incomplete === 'evaluating'))
          later = setTimeout(refresh, coverageReadDelayMs);
      },
      (failure: unknown) => {
        if (!current) return;
        failedInARow.current += 1;
        if (readFailureOutcome(failure, true) === 'access_lost') {
          setShown(null);
          setError(errorMessage(failure));
        } else if (readsCoverageAgain(failure, failedInARow.current)) later = setTimeout(refresh, coverageReadDelayMs);
        else setError(errorMessage(failure));
      },
    );
    return () => {
      current = false;
      clearTimeout(later);
    };
  }, [client, adoptionId, reload, refresh]);
  const unavailable = error && (
    <Notice tone="alert" title="Coverage by rule is unavailable">
      {error}{' '}
      <Button
        kind="quiet"
        onClick={() => {
          failedInARow.current = 0;
          refresh();
        }}
      >
        Try again
      </Button>
    </Notice>
  );
  if (!shown) return unavailable || <Spinner label="Reading coverage by rule" />;
  const rule = chosen && shown.rules.find((item) => item.leafId === chosen.leafId);
  return (
    <section aria-label="Coverage by rule" data-testid="rule-coverage">
      {unavailable}
      <h5>Coverage by rule</h5>
      {shown.sections.map((section) => (
        <section
          key={section.id}
          aria-label={section.title}
          data-testid="rule-coverage-section"
          data-section={section.id}
        >
          <h6 className="rule-coverage-section-title">{section.title}</h6>
          <p className="rail-muted" data-testid="rule-coverage-section-counts">
            {sectionWords(section)}
          </p>
          <table className="sms-ledger-table rule-coverage-table">
            <thead>
              <tr>
                <th scope="col">Rule</th>
                <th scope="col">How it is checked</th>
                <th scope="col">Counted over</th>
                <th scope="col">Latest results</th>
              </tr>
            </thead>
            <tbody>
              {shown.rules
                .filter((item) => section.leafIds.includes(item.leafId))
                .map((item) => (
                  <tr key={item.leafId} data-testid="rule-coverage-row" data-rule={item.leafId}>
                    <th scope="row">
                      {item.title}
                      {item.paragraph && (
                        <>
                          {' '}
                          <span className="rail-muted" data-testid="rule-paragraph">
                            {item.paragraph}
                          </span>
                        </>
                      )}
                    </th>
                    <td>{checkedByLabels[item.checkedBy]}</td>
                    <td>
                      {item.populationSize === null ? '—' : `${populationWords(item)}: ${item.populationSize}`}
                      {emptyPopulationHint(item) && <p className="rail-muted">{emptyPopulationHint(item)}</p>}
                    </td>
                    <td>
                      {item.counts &&
                        shownCounts(item.counts).map(({ result, count }) => (
                          <Button
                            key={result}
                            kind="quiet"
                            aria-pressed={chosen?.leafId === item.leafId && chosen.result === result}
                            onClick={() => setChosen({ leafId: item.leafId, result })}
                          >
                            {count} · {coverageResultLabels[result]}
                          </Button>
                        ))}
                      {item.counts && completeness(item, shown.populationLimit) && (
                        <p className="rail-muted">{completeness(item, shown.populationLimit)}</p>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      ))}
      {chosen && rule && (
        <RuleSubjects
          key={`${chosen.leafId}/${chosen.result}`}
          client={client}
          adoptionId={adoptionId}
          leafId={chosen.leafId}
          title={rule.title}
          result={chosen.result}
          onClose={() => setChosen(null)}
        />
      )}
    </section>
  );
}

/** The subjects behind one count, a page at a time; each opens its findings. */
function RuleSubjects({
  client,
  adoptionId,
  leafId,
  title,
  result,
  onClose,
}: {
  client: LedgerClient;
  adoptionId: string;
  leafId: string;
  title: string;
  result: CoverageResult;
  onClose: () => void;
}) {
  const [pages, setPages] = useState<RuleCoverageSubjectsResponse[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [subject, setSubject] = useState<NamedSubject | null>(null);
  useEffect(() => {
    let current = true;
    const read = (again: boolean) =>
      client.ruleCoverageSubjects(adoptionId, leafId, { result, ...(cursor ? { cursor } : {}) }).then(
        (page) => {
          if (!current) return;
          setPages((earlier) => (cursor ? [...earlier, page] : [page]));
          setError(null);
        },
        (failure: unknown) => {
          if (!current) return;
          const step = readFailureStep(readFailureOutcome(failure, false), again);
          if (step === 'read_again') void read(false);
          else {
            if (step === 'clear') setPages([]);
            setError(errorMessage(failure));
          }
        },
      );
    void read(true);
    return () => {
      current = false;
    };
  }, [client, adoptionId, leafId, result, cursor]);
  const subjects = pages.flatMap((page) => page.subjects);
  const last = pages.at(-1);
  return (
    <section className="rail-card" aria-label={`${coverageResultLabels[result]}: ${title}`} data-testid="rule-subjects">
      <h4>
        {coverageResultLabels[result]} · {title}
      </h4>
      <Button kind="quiet" onClick={onClose}>
        Close
      </Button>
      {error && (
        <Notice tone="alert" title="Subjects are unavailable">
          {error}
        </Notice>
      )}
      {!pages.length && !error && <Spinner label="Reading subjects" />}
      <ul>
        {subjects.map((item) => (
          <li
            key={`${item.subject.scope}/${item.subject.sourceId ?? ''}/${item.subject.id}`}
            data-testid="rule-subject"
          >
            <Button kind="quiet" onClick={() => setSubject(item.subject)}>
              {subjectLabel(item.subject)}
            </Button>{' '}
            <span className="rail-muted">
              {item.missing.length ? missingWords(item.missing) : (item.evaluation?.summary ?? 'Not yet evaluated.')}
            </span>
          </li>
        ))}
      </ul>
      {last?.page.hasMore && last.page.nextCursor && (
        <Button kind="secondary" onClick={() => setCursor(last.page.nextCursor!)}>
          Show more
        </Button>
      )}
      {subject && (
        <>
          <h4>Findings · {subjectLabel(subject)}</h4>
          <SubjectFindings key={JSON.stringify(subject)} client={client} subject={subject} />
        </>
      )}
    </section>
  );
}

/** Picks a subject on record by kind and name, instead of typing ids, and shows its findings. */
export function SubjectPicker({ client }: { client: LedgerClient }) {
  const [kind, setKind] = useState<NamedSubject['kind']>('person');
  const [search, setSearch] = useState('');
  const [asked, setAsked] = useState('');
  const [listed, setListed] = useState<SubjectsOnRecordResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [subject, setSubject] = useState<NamedSubject | null>(null);
  useEffect(() => {
    let current = true;
    setListed(null);
    client.subjectsOnRecord({ kind, ...(asked ? { search: asked } : {}) }).then(
      (response) => {
        if (!current) return;
        setListed(response);
        setError(null);
      },
      (failure: unknown) => current && setError(errorMessage(failure)),
    );
    return () => {
      current = false;
    };
  }, [client, kind, asked]);
  function submit(event: FormEvent) {
    event.preventDefault();
    setAsked(search.trim());
  }
  return (
    <>
      <form className="records-subject" onSubmit={submit}>
        <label htmlFor="findings-kind">Subject kind</label>
        <select
          id="findings-kind"
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as typeof kind);
            setSubject(null);
          }}
        >
          {observationSubjectKindValues.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <label htmlFor="findings-search">Name or id contains</label>
        <input id="findings-search" value={search} onChange={(event) => setSearch(event.target.value)} />
        <Button kind="next" type="submit">
          Search
        </Button>
      </form>
      {error && (
        <Notice tone="alert" title="Subjects are unavailable">
          {error}
        </Notice>
      )}
      {!listed && !error && <Spinner label="Reading subjects on record" />}
      {listed && (
        <ul aria-label="Subjects on record" data-testid="subjects-on-record">
          {listed.subjects.length === 0 && <li className="rail-muted">No {kind} on record matches.</li>}
          {listed.subjects.map((item) => (
            <li key={`${item.scope}/${item.sourceId ?? ''}/${item.id}`}>
              <Button
                kind="quiet"
                aria-pressed={subject?.id === item.id && subject.sourceId === item.sourceId}
                onClick={() => setSubject(item)}
              >
                {subjectLabel(item)}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {listed?.page.hasMore && <p className="rail-muted">More match; narrow the search.</p>}
      {listed?.truncated && (
        <p className="rail-muted">More subjects are on record than one search reads; narrow the search.</p>
      )}
      {subject && <SubjectFindings key={JSON.stringify(subject)} client={client} subject={subject} />}
    </>
  );
}
