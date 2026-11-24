# What the proposed Part 108 pack reads, paragraph by paragraph

Status: built. Pack: `packages/pack-part108-nprm` (`ledger.part108-nprm`, version 3). The paragraphs are those of the proposed 14 CFR Part 108 in the retained Federal Register notice (FR Doc. 2025-14992); that text is the authority, and this page is a reader's summary of it. It is proposed text, not current law: the pack is adopted in shadow only.

This page lists every paragraph of Subparts A, B, C and E, with the rule that reads it or the reason none does. A rule reports what is on file and what is not; it never says an operation conforms to anything. Where a rule reads a paragraph, what the records cannot show is left to a person, and the rule's own words say so.

Read the table by its third column:

- **A rule id** (`108.40.a.1` stands for `ledger.nprm.108.40.a.1`): a check runs on the organization's records. *A person* means the pack carries the paragraph as one a person checks.
- **A manufacturer's duty** or **a duty of the authority**: the paragraph asks something of someone other than the operator.
- **Nothing a record shows**: the paragraph turns on conduct at the moment, a judgment, or a request made at the time, and no record type holds it.
- **No record type holds it**: a record could show it, but none of Ledger's record types has the fields yet. These are the candidates for a later pack version.

On the Rules screen, in `pnpm pack:list ledger.part108-nprm` and in `pnpm ledger coverage`, the rules are grouped under the same section headings, each with the paragraph it reads beside its title.

## Subpart A: General

| Paragraph | What it asks | Rule, or why none |
| --- | --- | --- |
| § 108.1(a), (b) | Whom the part applies to | None: applicability, nothing a record shows |
| § 108.5 | Definitions | None: definitions |
| § 108.10(a), (b) | No false or altered records; the consequences | None: whether a record is false is for a person. Ledger keeps every record append-only |
| § 108.15 | No interference with operations personnel | None: conduct of other people, nothing a record shows |
| § 108.20(a)(1), (2) | Authorization and identification at hand, shown on request | None: nothing a record shows |
| § 108.20(a)(3), (c), (d) | Records made available on request | None: done when asked. A production of records (`docs/design/record-productions.md`) serves the request; no rule checks it |
| § 108.20(b) | Let the authority witness tests and inspect | None: nothing a record shows |
| § 108.25 | Safety reports not used for enforcement | None: a duty of the authority |
| § 108.30(a) | A principal base of operations, stated in the application | `108.505.b.2` looks for the document stating the address |
| § 108.30(b) | An address for correspondence | `108.505.b.1` looks for the contact information document |
| § 108.30(c) | Notice 30 days before the base moves | None: no record type holds a change of base or its notice |
| § 108.30(d) | Operations away from the base, as authorized | None: an authorization, nothing a record shows |
| § 108.35(a) | Operate under the business name on the certificate | None: nothing a record shows |
| § 108.35(b) | The operator's identity displayed on the aircraft | None: no record type holds the aircraft's markings |
| § 108.40(a)(1) | Total time in service of each aircraft | `108.40.a.1` |
| § 108.40(a)(2) | Status of life-limited parts | `108.615.a` reads each life-limited part record against its limit |
| § 108.40(a)(3)(i) | Time, date and duration of each flight | `108.40.a.3.i` |
| § 108.40(a)(3)(ii) | Registration number | `108.40.a.3.ii` |
| § 108.40(a)(3)(iii) | Type of operation | `108.40.a.3.iii` |
| § 108.40(a)(3)(iv) | Path, origin, destination and heights | `108.40.a.3.iv` |
| § 108.40(a)(3)(v) | Operations personnel assigned | `108.40.a.3.v` |
| § 108.40(a)(3)(vi) | Landing places | `108.40.a.3.vi` |
| § 108.40(a)(3)(vii) | Pickup and delivery points (package delivery) | None: no record type holds them |
| § 108.40(a)(3)(viii) | Customer, date and material dispensed (agriculture) | None: no record type holds them |
| § 108.40(b)(1)-(3) | Name, qualifications, duties of each person | `108.40.b.1-3` |
| § 108.40(b)(4) | Release from employment for cause | `108.40.b.4` |
| § 108.40(b)(5) | Shifts, rest before duty, hours on duty per day | `108.40.b.5` |
| § 108.40(c) | A log of mechanical irregularities and actions | `108.40.c` |
| § 108.40(d)(1) | Inspection status; each maintenance entry | `108.40.d.1`; `108.610.b` reads the inspection status |
| § 108.40(d)(2), (3) | Exceptions for swapped batteries and toolless parts | None: an exception for a person to apply |
| § 108.40(e)(1)(i), (ii) | Name, job function, date of hire | None of its own: the person's name and duties are read by `108.40.b.1-3`; the employment record holds the date, and no rule reads it for training |
| § 108.40(e)(1)(iii)-(vi) | Training date, materials, provider, certification | `108.40.e.1` |
| § 108.40(e)(2) | Which training records are kept | `108.315.d` reads initial and recurrent training; hazardous materials and agricultural training: none, no record type tells them apart |
| § 108.40(f) | How long records are kept | None: Ledger never deletes a record; how long the organization keeps its own copies is for a person |
| § 108.45(a)(1) | Flight hours per aircraft reported | `108.45.h.1.flight-hours` |
| § 108.45(a)(2) | Reliability data to the manufacturer | `108.45.h.1.reliability-data` |
| § 108.45(b) | Registration and serial numbers reported | `108.45.h.2` |
| § 108.45(c) | Summary of interruptions | `108.45.h.3` |
| § 108.45(d)(1) | Failures causing loss of control or communication reported to the manufacturer | `108.45.h.4` |
| § 108.45(d)(2) | Failures of an approved data service reported to its provider | `108.45.d.2` |
| § 108.45(d)(3), (e)(5) | Reports and further information given on request | None: done when asked |
| § 108.45(e)(1)-(4) | Security breaches reported, with what they hold | `108.45.h.5` reads the time; what the report held is for a person |
| § 108.45(f) | Emergency deviation reported within 10 days | `108.45.f` |
| § 108.45(g) | Property damage or unauthorized-area event reported | `108.45.h.7` |
| § 108.45(h)(1)-(5), (7) | When each report is due | The rules above count each deadline |
| § 108.45(h)(6) | Emergency deviation reports within 10 days | `108.45.f`, which counts the days as § 108.45(f) states them |

## Subpart B: Operating rules

| Paragraph | What it asks | Rule, or why none |
| --- | --- | --- |
| § 108.100(a), (b) | Operate, and advertise, only under a permit or certificate | None: the authority's issuance. A waiver or certificate pack states its own (`docs/design/waiver-relief.md`) |
| § 108.105(a) | Aircraft and elements in condition for safe operation | `108.120.a` reads the recorded condition |
| § 108.105(b), (c) | Airworthiness acceptance and equipage | None: a manufacturer's duty and the authority's acceptance (Subparts G and H) |
| § 108.110(a)-(c) | Anti-collision and position lighting | None: a manufacturer's equipage, and no record holds the lighting used |
| § 108.115 | An effective registration | None of its own: `108.40.a.3.ii` reads the registration number on file; whether it was effective on the day is for a person |
| § 108.120(a) | Not flown with a known unsafe condition | `108.120.a` |
| § 108.120(b) | Manufacturer's operating instructions followed | None: nothing a record shows |
| § 108.120(c) | Required instruments and equipment operational | `108.610.c.dock`, `.control-link`, `.battery`, `.sensors` read availability; `108.555.a` reads inoperative detect-and-avoid equipment |
| § 108.120(d) | The operations supervisor's responsibility | `108.305.a` reads that one is in the role; the responsibility is for a person |
| § 108.125(a)-(c) | No careless or reckless operation | None: conduct, nothing a record shows |
| § 108.130(a), (b) | Manuals at hand during operations | None of its own: `108.505.b.6` looks for the company manual; being at hand is nothing a record shows |
| § 108.135(a)-(g) | The company operations manual and what it addresses | `108.505.b.6` looks for it on file; its content is for a person |
| § 108.140(a), (b) | Speed and weight within the manufacturer's and the certificate's limits | None: no record holds the manufacturer's limits |
| § 108.145 | Weather within the manufacturer's limits | `108.170.a` reads the weather determination before flight |
| § 108.150(a) | Pre-designated, access-controlled locations | `108.165.c` reads the takeoff, landing and loading areas each operating area describes |
| § 108.150(b) | Controlled from within the United States | None: no record holds where the control station was |
| § 108.150(c) | Physical security policies and processes | `108.150.c` |
| § 108.155 | Location and height known throughout flight | None of its own: `108.165.a.flown` and `108.175.a` read the positions a source reports; whether they were known at all times is for a person |
| § 108.160 | No ADS-B Out or transponder transmitting | None: no record holds the transmit mode |
| § 108.165(a) | Approval for each operating area | `108.165.a` (each operating area on file names its approval) and `108.165.a.flown` (positions flown inside an operating area on file) |
| § 108.165(b) | Alternate landing areas | `108.165.b` |
| § 108.165(c) | Takeoff, landing and loading areas | `108.165.c` |
| § 108.165(d) | Communications coverage and lost link procedures | `108.165.d` |
| § 108.165(e) | Planned operations minimize ground risk | A person (`108.165.e`) |
| § 108.170(a) | Weather determined before flight | `108.170.a` |
| § 108.170(b) | Airspace and flight restrictions | `108.170.b` |
| § 108.170(c) | Population density overflown | None: no record holds the population category |
| § 108.170(d) | Ground obstacles and hazards | `108.170.d` |
| § 108.170(e) | Condition for safe operation | `108.120.a` |
| § 108.170(f) | Sufficient personnel | None: no record states the personnel an operation needs |
| § 108.170(g) | A deconflicted operational intent accepted before takeoff | None: no record type holds a data service's acceptance |
| § 108.170(h) | Power, link and load before flight | `108.170.h` |
| § 108.170(i) | Weight and balance | None: no record holds the manufacturer's limits |
| § 108.170(j), (k) | Attached objects secure; navigation and communication working | None of their own: `108.170.h` reads the control link, energy and load determination; the rest is for a person |
| § 108.175(a) | At most 400 feet above ground | `108.175.a` |
| § 108.175(b)-(d) | Temporary restrictions, military areas, airport traffic | None of their own: `108.170.b` reads the airspace determination |
| § 108.180(a), (b) | Controlled airspace: height, deconfliction, detect and avoid | None of their own: `108.175.a` reads the height; no record says which airspace class was flown or which data service was used |
| § 108.180(c), (d)(1) | An authorization for designated airspace | `108.180.d.1` |
| § 108.180(d)(2), (e) | Temporary prohibitions; incorporation by reference | None: a duty of the authority |
| § 108.185(a)-(d) | Operation over people by category | None: no record holds population categories or the people overflown |
| § 108.190(a)-(e) | Strategic deconfliction and conformance monitoring | None: no record type holds a data service's deconfliction or alerts; (c) and (d) are the service provider's capability |
| § 108.195(a), (b) | Right of way | None: conduct, nothing a record shows |
| § 108.200(a), (b) | Remote identification with operational status | None: the identity record names the method; the message elements are a manufacturer's duty |
| § 108.205 | Shielded operations | None: nothing a record shows |
| § 108.210(a) | One aircraft per coordinator unless a method allows more | None of its own: `108.210.b` and `108.210.c` read each multiple-aircraft record |
| § 108.210(b) | Within the method's limit | `108.210.b` |
| § 108.210(c) | Within the manufacturer's limit | `108.210.c` |
| § 108.215(a), (b) | Deviation authority and in-flight emergencies | None: nothing a record shows |
| § 108.215(c) | Report a deviation | `108.45.f` |
| § 108.220 | Flight restrictions under part 74 | None: no record holds them |

## Subpart C: Operations personnel

| Paragraph | What it asks | Rule, or why none |
| --- | --- | --- |
| § 108.300(a) | Roles the manual names | None: the manual's content, for a person |
| § 108.300(b) | No unsafe concurrent roles | None: no rule compares one person's assignments across roles |
| § 108.305(a) | An operations supervisor | `108.305.a` |
| § 108.305(b) | Notice within 10 days of a change of operations supervisor | `108.305.b` |
| § 108.305(c) | What the supervisor knows | None: nothing a record shows |
| § 108.310(a) | A coordinator designated when instructions require one | `108.310.a` |
| § 108.310(b) | Only qualified, authorized coordinators direct the aircraft | None of its own: `108.310.e` and `108.310.f` read experience; the operator's authorization is for a person |
| § 108.310(c) | Handover under a procedure | `108.310.c` |
| § 108.310(d) | What a coordinator does in flight | None: conduct |
| § 108.310(e) | 5 hours supervised in the make and model | `108.310.e` |
| § 108.310(f) | 5 hours as coordinator in the preceding 12 calendar months | `108.310.f` |
| § 108.310(g) | Requalification after a lapse | None of its own: the experience record names a qualification record; whether it followed a lapse is for a person |
| § 108.315(a)-(c) | Training subject areas | None of their own: `108.315.d` reads the dates; the subject areas are for a person |
| § 108.315(d) | Training within 24 calendar months | `108.315.d` |
| § 108.320 | No one serving with a known interfering condition | None: a person's declaration can be recorded, but the paragraph turns on what is known |
| § 108.325(a)-(d) | Alcohol and drugs | None: the same |
| § 108.330(a) | 14-hour duty day, 50-hour duty week | `108.330.a.duty-period`, `108.330.a.duty-week` |
| § 108.330(b) | 10 hours' rest before duty | `108.330.b` |
| § 108.330(c) | A day of rest each week | `108.330.c` |
| § 108.335(a) | A security threat assessment for each covered person | `108.335.a`, for each operations supervisor and flight coordinator on record |
| § 108.335(b) | Who is a covered person | `108.335.b` says when no operations supervisor or coordinator is on record; people with access to the aircraft, its cargo or its control are named by no record, and are for a person |
| § 108.335(c) | A declaration in the application | None: the application's content |
| § 108.335(d)-(g) | Renewal, removal, revocation, redress | None of their own: `108.335.a` reads the latest assessment recorded as held |

## Subpart E: Certificated operations

| Paragraph | What it asks | Rule, or why none |
| --- | --- | --- |
| § 108.500(a)-(d) | The types of operations a certificate covers | None: the authority's certificate; flight plans record each flight's type, read by `108.40.a.3.iii` |
| § 108.505(a) | An application in a form the authority accepts | None: the application itself |
| § 108.505(b)(1)-(16) | What the application addresses | `108.505.b.1` to `108.505.b.16`: a document serving each item in force, or for (b)(3) the operations supervisor on record |
| § 108.505(b)(17) | Further information the authority asks for | A person (`108.505.b.17`) |
| § 108.510, § 108.515, § 108.520 | Duration, issuance, denial and revocation | None: a duty of the authority |
| § 108.525(a)-(d) | Amendment of a certificate | None: the authority's, and the operator's petition |
| § 108.530(a) | Each authorized operation conducted in the last 12 months | A person (`108.530.a`) |
| § 108.530(b) | Authorization to resume | None: a duty of the authority |
| § 108.535(a) | Cybersecurity policies and processes | `108.535.a` |
| § 108.535(b) | What the policy includes | None of its own: `108.535.a` reads it on file; its content is for a person |
| § 108.535(c) | Reviewed at least annually | `108.535.c` |
| § 108.540(a) | A training program | `108.540.a` |
| § 108.540(b), (c) | Facilities, material and contracted training | None: nothing a record shows |
| § 108.540(d) | A person responsible for training | `108.540.d` |
| § 108.540(e), (f) | Revisions the authority asks for | None: a duty of the authority, and the operator's petition |
| § 108.545(a) | Validation tests | A person (`108.545.a`): the tests are conducted with the authority |
| § 108.545(b), (c) | How validation tests are conducted | None: the authority's |
| § 108.550(a) | A communication assessment | A person (`108.550.a`); `108.505.b.11` looks for the assessment on file |
| § 108.550(b) | A ground risk assessment | None of its own: `108.505.b.11` looks for it on file |
| § 108.555(a) | Inoperative equipment only with a determination it is not a hazard | `108.555.a` reads detect-and-avoid equipment recorded inoperative before each flight; other equipment is held by no record and is for a person |
| § 108.555(b) | Procedures for inoperative equipment | `108.505.b.14` |
| § 108.560(a) | A safety management system | `108.560.a.safety-policy`, `.risk-matrix`, `.safety-reporting`, `.accountable-executive`, `.hazards`; the rest a person (`108.560.a`) |
| § 108.560(b) | Exceptions for a sole individual | A person (`108.560.b`) |
| § 108.560(c) | Information available on request | A person (`108.560.c`) |
| § 108.565(a)-(f) | Package delivery operations | None: no record type holds deliveries; package delivery operators only |
| § 108.570(a)-(l) | Hazardous materials | None of their own: `108.505.b.13` looks for the procedures on file; no record type holds hazardous materials handling or its training |
| § 108.575(a)-(h) | Agricultural operations | None: no record type holds dispensing |
| § 108.580(a), (b) | Aerial surveying | None: the certificate's type, and no record holds gross weight or population category |
| § 108.585(a)-(d) | Civic interest operations | None: no record type holds the contract or coordination |

## Subpart F, as far as the pack reads it

| Paragraph | Rule |
| --- | --- |
| § 108.610(b) | `108.610.b`: per aircraft, now, within the next due time and the next due hours in service of its latest inspection, whichever comes first (`due.time-or-total@1`); the hours are its latest complete total and the flights since |
| § 108.610(c) | `108.610.c.dock`, `.control-link`, `.battery`, `.sensors` |
| § 108.615(a) | `108.615.a` |
| § 108.620(a) | `108.620.a`: a battery monitoring program on file |
| § 108.620(b) | A person (`108.620.b`) |
| § 108.630(a) | `108.630.a`, per aircraft; and `108.630.a.flight`, per flight: a flight planned after maintenance not recorded as returned to service needs attention |

## Operating areas

An operating area is the organization's own record (`organization.operating-area`), one per area, by the organization's own id. Its shape is a circle (a centre written as latitude, longitude in decimal degrees, and a radius) or a corridor (points along a line, written as latitude, longitude pairs separated by semicolons, and a half-width). A radius or half-width is at most 50,000 m (`OPERATING_AREA_SIZE_LIMIT_METERS` in `packages/contracts/src/operating-areas.ts`): the entry form and an imported file refuse more, and the check leaves out any record above it, so the bound a person reads and the bound the check enforces are the same number. An area is current from `startsAt` until `endsAt` (none recorded: still current).

- `108.165.a`, `.b` and `.c` give one result for the organization: each current area, named by its id, states its approval, its alternate landing areas, or its takeoff, landing and loading areas. With none current the result is "No operating area in force is on file".
- `108.165.a.flown` places each position a source reported for the planned aircraft in the planned window against every area current at the time of that position: a position inside any of them is inside. A corridor is measured along its geodesic line, so a long leg is measured as accurately as a short one. An area whose shape cannot be read is named in the result and left out. With no area on file the result is "No operating area on file".
