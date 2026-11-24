# Risk levels on an organization's own matrix

Design note. Builds on the safety record envelope (`sms-envelope.ts`), the risk decisions (`sms-decisions.ts`) and the one hazard model (`one-hazard-model.md`). No migration: the matrix and the recorded positions are JSON bodies.

## The gap

A risk matrix had exactly three levels, `low`, `medium` and `high`, each tied to the risk acceptance capability of the same name. An operator who brings its own matrix brings its own bands: four, say, the highest meaning "stop: nobody may accept". Two bands had to be merged, and Ledger then let a person with `risk:accept:high` accept a risk the operator's own manual says nobody may accept.

## 1. Levels on a matrix

`sms.risk-matrix.1` is changed in place (Ledger has no users yet; no second version is kept).

- `levels` is a list of **two to six** levels, **least to most serious**. Each has:
  - `id`: the organization's own short id for it (`green`, `band_4`), lowercase letters, digits and `_`, unique in the matrix;
  - `label`: the organization's name for it (`Green`), unique in the matrix;
  - `meaning`: what it means for them, in their words (`Stop the affected operation.`);
  - `acceptance`: who may accept a risk at this level: `low`, `medium` or `high`, the acceptance authority it needs, or `not_acceptable`, meaning nobody may.
- Every cell names one of the matrix's level ids.
- The levels are in order: a later level never needs less authority than an earlier one (`low` < `medium` < `high` < `not_acceptable`). Two levels may need the same authority. The first level may be accepted by someone, so a matrix always has a level that can be accepted.
- The severity and likelihood axes are unchanged: five of each, least to most.

The **three risk acceptance capabilities stay as they are**: `risk:accept:low`, `risk:accept:medium`, `risk:accept:high`, a higher one covering the lower ones. A level maps to one of them or to none. The organization's level names never become capabilities.

The standard form a new organization starts from (`standardRiskMatrix`) and the seeded example (`exampleRiskMatrix`) keep three levels, `low`, `medium`, `high`, each accepted with the authority of the same name, so the seed and the recorded scenes keep a three-level matrix.

Example, an operator's four bands:

| id | label | acceptance |
| --- | --- | --- |
| `green` | Green | `low` (the safety manager) |
| `yellow` | Yellow | `high` (the director) |
| `orange` | Orange | `high` (the director) |
| `red` | Red | `not_acceptable` |

## 2. What an assessment records

An assessment cites the adopted matrix version, as before. Ledger computes each position from it and records it with the level's acceptance at that moment:

```
initial / residual: { severity, likelihood, level: <level id>, acceptance: low | medium | high | not_acceptable }
```

Copying `acceptance` into the position lets every read and screen say who may accept without loading the matrix, and it is fixed by the assessed matrix version anyway (the assessment pins its body digest). A risk acceptance records `level` (the level id) and `acceptance` (the authority it was accepted under).

## 3. Accepting, and the level nobody may accept

Accepting the residual risk needs the capability that covers the level's acceptance (`coveringRiskCapability`, unchanged: the lowest held capability at or above it).

A residual risk at a level whose acceptance is `not_acceptable` **cannot be accepted by anyone**. The signing preview, the record's accept action and the `risk.accept` command all refuse with `409 risk_not_acceptable`, in the matrix's own words:

> “Example Ridge risk matrix” says Red risk may not be accepted: Stop the affected operation. Reassess with further controls.

An assessment at such a level is still recorded: it is what the assessor found. The hazard stays awaiting acceptance, is waiting on nobody, and its residual position says it may not be accepted until a person reassesses it with further controls.

## 4. Every read and screen that shows a level

| Where | What it shows |
| --- | --- |
| Matrix form (Safety, risk matrix) | Two to six levels, added and removed in order, each with its name, meaning and who may accept it (one of the three authorities, or "Nobody may accept"); every cell picks one of them |
| Matrix adoption, signed content | The levels with what each means and who may accept it, so the signer sees a level nobody may accept |
| Hazard page and register | The residual level in the matrix's label; its tone comes from its acceptance (low neutral, medium advisory, high and not acceptable alert); a level nobody may accept says so |
| Hazard accept action and signing preview | Unavailable for a level nobody may accept, with the sentence above; otherwise who in the organization may accept it |
| Safety home | `people[].authority` stays the highest of the three authorities a person holds; `waitingOnMe` never lists a risk nobody may accept |
| First steps | Unchanged: who may accept low, medium and high risk |
| `pnpm ledger safety home` | Each hazard's residual level by label and who may accept it, or that nobody may |
| API | `RiskMatrixBody`, `AssessedPosition` and the acceptance outcome as above |

## 5. What moves

- The standard and example matrix bodies gain `acceptance` on each level, so their body digests change, and so does every seeded matrix version's.
- The recorded scenes that show a matrix or a hazard's level replay API responses of the old shape and must be recorded again: `hazard`, `documents`, `lostlink` and `wind`.
- No control type, pack or calculation context digest moves.
