import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { observationSubjectKindValues } from '@ledger/contracts';
import type {
  AdoptionRuleCoverageResponse,
  CoverageResult,
  NamedSubject,
  RuleCoverage,
  RuleCoverageSubjectsResponse,
  SubjectsOnRecordResponse,
} from '@ledger/contracts';
import type { LedgerClient } from '@ledger/contracts/client';
import { Badge, Button, Notice, Spinner } from '@ledger/ui';
import { coverageReadDelayMs, readsCoverageAgain } from './coverage-read.js';
import { errorMessage } from './format.js';
import { readFailureOutcome, readFailureStep } from './read-failure.js';
import { modeLabels } from './rule-adoption.js';
import {
  checkedByLabels,
  completeness,
  coverageFilterLabels,
  coverageGroups,
  coverageResultLabels,
  emptyPopulationHint,
  filterCounts,
  missingWords,
  nothingYetIn,
  nothingYetTitle,
  populationWords,
  sectionWords,
  shownCounts,
  type CoverageFilter,
} from './rule-coverage.js';
import { SubjectFindings } from './SubjectFindings.js';
import { subjectLabel } from './subject-label.js';

/**
 * One adoption's rules with their members counted by latest result. It opens with the rules counted by result, each
 * count a filter; sections fold, open where something asks a person, and the rules that count nothing yet are listed
 * apart at the end. A count opens the subjects behind it; a subject opens its findings. Reads again while a count is still being evaluated, and after a failed read, as the coverage
 * pane does.
 */
export function RuleCoverageTable({ client, adoptionId }: { client: LedgerClient; adoptionId: string }) {
  const [shown, setShown] = useState<AdoptionRuleCoverageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [chosen, setChosen] = useState<{ leafId: string; result: CoverageResult } | null>(null);
  const [filter, setFilter] = useState<CoverageFilter | null>(null);
  // What a person opened or closed, by filter and section, kept while the screen stays.
  const [folds, setFolds] = useState<Record<string, boolean>>({});
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
  const groups = coverageGroups(shown, filter);
  const opened = (id: string, opens: boolean) => folds[`${filter ?? 'everything'}/${id}`] ?? opens;
  const fold = (id: string, opens: boolean, open: boolean) => {
    // The toggle event also follows a change the screen made itself; only a person's own change is kept.
    if (open !== opened(id, opens)) setFolds((earlier) => ({ ...earlier, [`${filter ?? 'everything'}/${id}`]: open }));
  };
  return (
    <section aria-label="Coverage by rule" data-testid="rule-coverage">
      {unavailable}
      <h5>Coverage by rule</h5>
      <CoverageSummary rules={shown.rules} shadow={shown.mode === 'shadow'} filter={filter} onFilter={setFilter} />
      {groups.map(({ section, rules, opens }) => {
        const id = section ? `section/${section.id}` : 'nothing-yet';
        return (
          <details
            key={id}
            className="rule-coverage-section"
            aria-label={section?.title ?? nothingYetTitle}
            data-testid={section ? 'rule-coverage-section' : 'rule-coverage-nothing-yet'}
            data-section={section?.id}
            open={opened(id, opens)}
            onToggle={(event) => fold(id, opens, event.currentTarget.open)}
          >
            <summary>
              <h6 className="rule-coverage-section-title">{section?.title ?? nothingYetTitle}</h6>
              <p className="rail-muted" data-testid="rule-coverage-section-counts">
                {section
                  ? sectionWords(section, nothingYetIn(section, shown.rules))
                  : `${rules.length} ${rules.length === 1 ? 'rule covers' : 'rules cover'} no subject yet; each says what record would make it count.`}
              </p>
            </summary>
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
                {rules.map((item) => (
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
          </details>
        );
      })}
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

/**
 * The line a pack's coverage opens with: its rules counted by their subjects' latest results, each count a filter.
 * A shadow pack's counts carry the marking its heading carries.
 */
function CoverageSummary({
  rules,
  shadow,
  filter,
  onFilter,
}: {
  rules: readonly RuleCoverage[];
  shadow: boolean;
  filter: CoverageFilter | null;
  onFilter: (filter: CoverageFilter | null) => void;
}) {
  return (
    <div
      className="rule-coverage-summary"
      role="group"
      aria-label="Rules by result"
      data-testid="rule-coverage-summary"
    >
      {shadow && <Badge tone="advisory">{modeLabels.shadow}</Badge>}
      <span>
        {rules.length} {rules.length === 1 ? 'rule' : 'rules'}. Each count is of rules, not findings; a rule with
        subjects in several results is in each:
      </span>
      <Button kind="quiet" aria-pressed={filter === null} onClick={() => onFilter(null)}>
        Everything
      </Button>
      {filterCounts(rules).map(({ filter: value, count }) =>
        count ? (
          <Button key={value} kind="quiet" aria-pressed={filter === value} onClick={() => onFilter(value)}>
            {count} · {coverageFilterLabels[value]}
          </Button>
        ) : (
          <span key={value} className="rail-muted" data-testid="rule-coverage-empty-count">
            0 · {coverageFilterLabels[value]}
          </span>
        ),
      )}
    </div>
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
