import { describe, expect, it } from 'vitest';
import type { CheckedRuleLeaf } from '../../packages/contracts/src/index.js';
import { canonicalDigest } from '../../packages/integrity/src/index.js';
import { checkedRuleProblem, defineCheckedRule } from '../../packages/domain/src/checked-rules.js';
import { recordCompleteV2 } from '../../packages/domain/src/check-kind-library-records.js';
import { ruleEvaluationObservationDigest } from '../../packages/domain/src/rule-evaluations.js';
import {
  batteryReserveLeafV1,
  exampleOperationsRulePack,
} from '../../packages/pack-example-operations/src/example-operations-v1.js';
import {
  batteryAtLandingLeafV1,
  exampleOperationsRulePack as exampleOperationsRulePackWithVersionTwo,
} from '../../packages/pack-example-operations/src/example-operations-v2.js';
import { exampleWaiverRulePack } from '../../packages/pack-example-waiver/src/example-waiver-v1.js';
import { exampleWaiverRulePack as exampleWaiverRulePackWithVersionTwo } from '../../packages/pack-example-waiver/src/example-waiver-v2.js';
import {
  exampleAirspaceRulePack,
  operatingAreaLeafV1,
} from '../../packages/pack-example-airspace/src/example-airspace-v1.js';
import { assignedCrewLeafV1, exampleCrewRulePack } from '../../packages/pack-example-crew/src/example-crew-v1.js';
import {
  exampleWeatherRulePack,
  windAtDepartureLeafV1,
  windInFlightLeafV1,
} from '../../packages/pack-example-weather/src/example-weather-v1.js';
import {
  batteryForFlightLeafV1,
  exampleOperationsRulePack as exampleOperationsRulePackWithVersionThree,
} from '../../packages/pack-example-operations/src/example-operations-v3.js';
import {
  exampleAirspaceRulePack as exampleAirspaceRulePackWithVersionTwo,
  operatingAreaPerFlightLeafV1,
} from '../../packages/pack-example-airspace/src/example-airspace-v2.js';
import {
  excursionsPerFlightHourV1,
  excursionsPerFlightHourV2,
} from '../../packages/pack-example-airspace/src/indicators.js';
import {
  exampleWeatherRulePack as exampleWeatherRulePackWithVersionTwo,
  windAtTakeoffLeafV1,
  windForFlightLeafV1,
} from '../../packages/pack-example-weather/src/example-weather-v2.js';
import { flightsWithWindAboveLimitInFlightV1 } from '../../packages/pack-example-weather/src/indicators.js';
import {
  flightsWithWindAboveLimitV1,
  windExceedancesPer100FlightsV1,
} from '../../packages/pack-example-weather/src/indicators-v2.js';
import { part107RulePack } from '../../packages/pack-part107/src/part107-v1.js';
import { part108NprmRulePack } from '../../packages/pack-part108-nprm/src/part108-nprm-v1.js';

// Leaf fields added after these packs shipped are optional. Leaving them out must leave every pinned digest, and
// the input digest of every evaluation already recorded under these packs, exactly as it was.
describe('shipped packs keep their digests', () => {
  it('pins the pack, leaf and check definition digests', () => {
    const [examplePack] = exampleOperationsRulePack().versions;
    const [part108Pack] = part108NprmRulePack().versions;
    const leaf = batteryReserveLeafV1();
    expect(examplePack!.digest).toBe('e56e599b0e0fd54f8dbc9de743c1b61edb115a2f47b232358a2df80fea7606bb');
    expect(part108Pack!.digest).toBe('2829a7d8708be8bdd1d97771a0fdbaca2376a70769633ae546e31b1de5298584');
    expect(leaf.digest).toBe('e119073d540a6cb5f8b787bac62a251241d9aca6287538e52a72a8f03edcee32');
    expect(leaf.check.definitionDigest).toBe('e38354bd648f7dcab44bf6b7e776011e1302c454cf34784d8ac0461ea165802e');
    expect(checkedRuleProblem(leaf)).toBeUndefined();
    for (const pack of [examplePack!, part108Pack!]) {
      const { digest, ...content } = pack;
      expect(canonicalDigest(content)).toBe(digest);
    }
  });

  it('pins version 2 of the example operations pack, which adds a rule per flight about its aircraft', () => {
    const versions = exampleOperationsRulePackWithVersionTwo().versions;
    expect(versions.map((pack) => [pack.version, pack.digest])).toEqual([
      [1, 'e56e599b0e0fd54f8dbc9de743c1b61edb115a2f47b232358a2df80fea7606bb'],
      [2, 'ec66aed0739dff9130ef804ec03f704118831e511a0f5788a9ce53089c0279b8'],
    ]);
    expect(batteryAtLandingLeafV1().digest).toBe('3c1d0c12a086b2d9d3b9be959d8d0d170ee1ab5e3e7611f97470c8f5f982ffeb');
    expect(versions[1]!.leaves[0]).toEqual(batteryReserveLeafV1());
  });

  it('pins the Part 107 pack, which quotes in-force text from a retained XML document', () => {
    const [part107Pack] = part107RulePack().versions;
    expect(part107Pack!.digest).toBe('0daefd9d75ae430ccf9d6499f0c9104eeb4668752b250b81193ad6e412bbc3d9');
    const { digest, ...content } = part107Pack!;
    expect(canonicalDigest(content)).toBe(digest);
  });

  it('pins the later regulatory pack versions, which read related subjects and combine records', () => {
    expect(part108NprmRulePack().versions.map((pack) => [pack.version, pack.digest])).toEqual([
      [1, '2829a7d8708be8bdd1d97771a0fdbaca2376a70769633ae546e31b1de5298584'],
      [2, '27244ddf8f60502a791a8c8c6144a08cd092e8ffba6915a388c80da27ce7e6e2'],
      [3, 'e95017f405bd0a007cc636a3dd487685f59da94b4146d24c6af3b7b2e93f4dab'],
    ]);
    expect(part107RulePack().versions.map((pack) => [pack.version, pack.digest])).toEqual([
      [1, '0daefd9d75ae430ccf9d6499f0c9104eeb4668752b250b81193ad6e412bbc3d9'],
      [2, '701c04fe1e9c8ad0e330b9826fe864391d0583cb706387f248d24c40e4b0a1c8'],
    ]);
  });

  it('pins the example waiver pack, which quotes an invented certificate retained beside it', () => {
    const [waiverPack] = exampleWaiverRulePack().versions;
    expect(waiverPack!.digest).toBe('2391a4bf35c864f294595420a71fe93712ed494bae252a177c07887c0528dd3c');
    expect(exampleWaiverRulePackWithVersionTwo().versions.map((pack) => [pack.version, pack.digest])).toEqual([
      [1, '2391a4bf35c864f294595420a71fe93712ed494bae252a177c07887c0528dd3c'],
      [2, '821114f93f9db2fbb53eeb06137ed397d58fed6ba91dd8b4a6eb9ea5f7dafea0'],
    ]);
    const { digest, ...content } = waiverPack!;
    expect(canonicalDigest(content)).toBe(digest);
  });

  it('pins the example airspace pack, its operating-area rule and the position check it uses', () => {
    const [airspacePack] = exampleAirspaceRulePack().versions;
    const leaf = operatingAreaLeafV1();
    expect(airspacePack!.digest).toBe('f67a8435a27ae4939dc4b7be15256965feda566aee6d4f6d3e9deb127d572d3c');
    expect(leaf.digest).toBe('46225c9155850910a799619ebf695cae67248515590a81f7fb278633d4741023');
    expect(leaf.check.definitionDigest).toBe('7189a2b6600ce14b9fcd9b0691d30e4a8ccde1dff8ef33573e7a819f9340d6f5');
    expect(checkedRuleProblem(leaf)).toBeUndefined();
    const { digest, ...content } = airspacePack!;
    expect(canonicalDigest(content)).toBe(digest);
  });

  it('pins the example crew pack, its rule per flight and the duty check its rules use', () => {
    const [crewPack] = exampleCrewRulePack().versions;
    const leaf = assignedCrewLeafV1();
    expect(crewPack!.digest).toBe('ae595a873cbf7b2b4f12726088c16a805a5383068728a284e03404145413bb38');
    expect(leaf.digest).toBe('ba093171af295bece7ff69f74df04d32425312f6a4900d42ed4b171ce2876c36');
    expect(leaf.check.definitionDigest).toBe('6f41afcc65c8fdca71a1ad2b46306d9e89e639c9211b9d88f38bfd8dd3017597');
    for (const item of crewPack!.leaves) expect(checkedRuleProblem(item as CheckedRuleLeaf)).toBeUndefined();
    const { digest, ...content } = crewPack!;
    expect(canonicalDigest(content)).toBe(digest);
  });

  it('pins the example weather pack and its two wind rules about the flight’s site', () => {
    const [weatherPack] = exampleWeatherRulePack().versions;
    expect(weatherPack!.digest).toBe('4d1dac7e716b00bf34fd90e7f0c027cc240a0d6710b57770a30913a4b81f3426');
    expect(windAtDepartureLeafV1().digest).toBe('72aaddd12677a3614c802d8d2bfac8f99abc3ad4c697ea4ff28e0686663b3551');
    expect(windInFlightLeafV1().digest).toBe('92be6a2d2c6a94b7d3df8203e840ff7a7b02a00529084a5d910cb0d67aefda02');
    for (const leaf of weatherPack!.leaves) {
      expect(leaf.check.definitionDigest).toBe('e38354bd648f7dcab44bf6b7e776011e1302c454cf34784d8ac0461ea165802e');
      expect(checkedRuleProblem(leaf as ReturnType<typeof windInFlightLeafV1>)).toBeUndefined();
    }
    const { digest, ...content } = weatherPack!;
    expect(canonicalDigest(content)).toBe(digest);
  });

  it('pins the evaluation input digest of a rule that reads no subject state', () => {
    const leaf = batteryReserveLeafV1();
    const [pack] = exampleOperationsRulePack().versions;
    // The value the evaluator recorded for these inputs before reads gained conditions, anchors and state.
    expect(
      ruleEvaluationObservationDigest({
        adoptionId: 'adoption-1',
        pack: { id: pack!.packId, version: pack!.version, digest: pack!.digest },
        leaf: { id: leaf.id, version: leaf.version, digest: leaf.digest },
        parameters: { field: 'values.totalRemainingPercent', comparison: 'at_least', limit: 25 },
        inputs: [{ name: 'subject', observationIds: ['observation-1'], truncated: false }],
      }),
    ).toBe('685897b28c7dc86645c5465086c183acf49b4a3b2dcc472ca7e4632eba09650b');
  });

  it('pins a checked rule leaf that quotes a retained document, and leaves its source as pinned', () => {
    const [part108Pack] = part108NprmRulePack().versions;
    const quoted = part108Pack!.leaves[0]!;
    if (quoted.source.kind !== 'proposed_regulation') throw new Error('Expected a retained-document source');
    const leaf = defineCheckedRule({
      id: 'test.retained-source',
      version: 1,
      title: 'Retained source digest pin',
      source: quoted.source,
      target: { subjectKind: 'person' },
      reads: [
        {
          name: 'record',
          type: 'operator.record',
          versions: [1],
          about: 'target',
          required: false,
          select: 'latest',
          where: [{ field: 'values.recordType', oneOf: ['person.standing'] }],
        },
      ],
      check: { kind: recordCompleteV2, params: { recordType: 'person.standing', recordVersion: 1 } },
    });
    expect(leaf.source).toEqual(quoted.source);
    expect(checkedRuleProblem(leaf)).toBeUndefined();
    expect(leaf.digest).toBe('712b7bd8817dd0dee2f963f2983b78f2b15e07a64bb6b8cce979e9e7eaee13db');
  });
  it('pins the later example pack versions over a window, their rules, the window kinds and the indicators', () => {
    expect(exampleOperationsRulePackWithVersionThree().versions.map((pack) => [pack.version, pack.digest])).toEqual([
      [1, 'e56e599b0e0fd54f8dbc9de743c1b61edb115a2f47b232358a2df80fea7606bb'],
      [2, 'ec66aed0739dff9130ef804ec03f704118831e511a0f5788a9ce53089c0279b8'],
      [3, 'cf73c9d22b643e9b7526e1adc1dff2fb7687e583ddbc9d2205db6ee2d1ea58d2'],
    ]);
    expect(exampleAirspaceRulePackWithVersionTwo().versions.map((pack) => [pack.version, pack.digest])).toEqual([
      [1, 'f67a8435a27ae4939dc4b7be15256965feda566aee6d4f6d3e9deb127d572d3c'],
      [2, '3ec667d5e305a7083990aed54ddcd05f488240db2e862807db3eb888a47ca074'],
    ]);
    expect(exampleWeatherRulePackWithVersionTwo().versions.map((pack) => [pack.version, pack.digest])).toEqual([
      [1, '4d1dac7e716b00bf34fd90e7f0c027cc240a0d6710b57770a30913a4b81f3426'],
      [2, '9c706716d0018e540ae00e4afb7b50f30d325642df0f1149a4981203a1530ad7'],
    ]);
    expect(batteryForFlightLeafV1().digest).toBe('d59cfa19f6583310d6c897e3be83aa79042be7d93708ce287b6890e20e93fae9');
    expect(operatingAreaPerFlightLeafV1().digest).toBe(
      '95fdd2f3bf3e5fc09f41c490ec34c99685ad771bb49c7d4375e0a7e3cdd0dd83',
    );
    expect(windAtTakeoffLeafV1().digest).toBe('fd723f2f9a5d56e59352839d84ca30aee036b8e60275e90132fd225067334e1b');
    expect(windForFlightLeafV1().digest).toBe('295a7ca56d538539517fe65e7589f2421e71ae096383adba784e810ff5ec6af4');
    expect(batteryForFlightLeafV1().check.definitionDigest).toBe(
      '7d8f793116b55ae85a0a0dc500850f991be2b9d026f8059fc49fbf2b98af3514',
    );
    expect(operatingAreaPerFlightLeafV1().check.definitionDigest).toBe(
      'd0410b2208043685b92140c9b403b23a4cf975a2a38eca9bafeedb42f77182a6',
    );
    for (const leaf of [batteryForFlightLeafV1(), operatingAreaPerFlightLeafV1(), windAtTakeoffLeafV1()])
      expect(checkedRuleProblem(leaf)).toBeUndefined();
    // The indicators over the earlier rules keep their digests; the new ones are pinned beside them.
    expect(
      [
        flightsWithWindAboveLimitInFlightV1(),
        windExceedancesPer100FlightsV1(),
        flightsWithWindAboveLimitV1(),
        excursionsPerFlightHourV1(),
        excursionsPerFlightHourV2(),
      ].map((definition) => definition.digest),
    ).toEqual([
      'd2ff86e1eeef322076d3f6d144141e339d1bacc2becd39f959039474fcbad890',
      '78cf08ac21a493c2e6ed3f5489370d11cd99f41d6343f22d78280b4ae17a49b7',
      '4591fee18369f32178173fd32c4b2e2df6b4926c18a760e5b34f1005253a4364',
      'd7d0e0b3d068a61a61e43f4f92301d85a7af7490228727d232d2126cd22c87f0',
      '8ec246849e8b307875adedccf075dbf9afbac161e178ea50884231f904555e1c',
    ]);
  });
});
