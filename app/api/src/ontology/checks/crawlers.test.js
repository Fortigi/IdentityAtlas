import { describe, it, expect } from 'vitest';
import { checkCrawlerTypes } from './crawlers.js';
import { checkIntegrity } from './integrity.js';
import { CONTEXT_TTL, edit, miniRegistry, modelOf } from '../__tests__/miniOntology.js';

// The context fixture plus crawler annotations: crawler "hr" writes User and
// Group and passes resource types through; crawler "idp" writes User.
const CRAWLER_TTL = `${CONTEXT_TTL}
ia:emittedBy a owl:AnnotationProperty . ia:passthroughFrom a owl:AnnotationProperty .
ia:User ia:emittedBy "hr", "idp" .
ia:Group ia:emittedBy "hr" .
ia:Resource ia:passthroughFrom "hr" .
`;
const registry = () => ({
  ...miniRegistry(),
  crawlers: [
    { type: 'hr', emits: { principalTypes: ['User'], resourceTypes: ['Group'], contextTypes: [], open: ['resourceType'] } },
    { type: 'idp', emits: { principalTypes: ['User'], resourceTypes: [], contextTypes: [], open: [] } },
  ],
});
const run = (reg = registry(), ttl = CRAWLER_TTL) => checkCrawlerTypes(modelOf(ttl), reg).map(f => `${f.code} ${f.subject}`);
const crawler = (reg, type) => reg.crawlers.find(c => c.type === type);

describe('checkCrawlerTypes', () => {
  it('finds nothing when the manifests and the ontology agree, and the fixture is structurally clean', () => {
    expect(checkCrawlerTypes(modelOf(CRAWLER_TTL), registry())).toEqual([]);
    expect(checkIntegrity(modelOf(CRAWLER_TTL))).toEqual([]);
  });

  it('skips the check when the registry has no crawlers', () => {
    expect(checkCrawlerTypes(modelOf(CRAWLER_TTL), miniRegistry())).toEqual([]);
  });

  describe('manifest shape', () => {
    it('requires an emits block', () => {
      const reg = registry();
      delete crawler(reg, 'idp').emits;
      // The User class still names idp, which now declares nothing: no stale finding for a crawler without emits.
      expect(run(reg)).toEqual(['crawler-emits-invalid crawler:idp']);
    });

    it('requires every list, and only type columns in open', () => {
      const reg = registry();
      delete crawler(reg, 'idp').emits.contextTypes;
      crawler(reg, 'hr').emits.open = ['resourceType', 'colour'];
      const out = checkCrawlerTypes(modelOf(CRAWLER_TTL), reg);
      expect(out.map(f => `${f.code} ${f.subject}`)).toEqual(['crawler-emits-invalid crawler:hr', 'crawler-emits-invalid crawler:idp']);
      expect(out.map(f => f.message)).toEqual([
        'emits.open names colour, which is not a type column (crawler.json)',
        'emits.contextTypes must be a list (crawler.json)',
      ]);
    });
  });

  describe('manifest → ontology', () => {
    // The required demonstration: a crawler starts writing a type the ontology lacks.
    it('fails for a type a crawler writes but the ontology does not define', () => {
      const reg = registry();
      crawler(reg, 'hr').emits.resourceTypes.push('Entitlement');
      expect(checkCrawlerTypes(modelOf(CRAWLER_TTL), reg)).toEqual([{
        code: 'crawler-type-undefined',
        subject: 'Resource:Entitlement',
        message: 'crawler hr writes resource type "Entitlement", which is not a subclass of ia:Resource in the ontology',
      }]);
    });

    it('fails when the ontology does not name the crawler that writes the type', () => {
      const reg = registry();
      crawler(reg, 'idp').emits.resourceTypes.push('Group');
      expect(run(reg)).toEqual(['crawler-emitter-undeclared ia:Group']);
    });

    it('looks a type up under the right kind of node', () => {
      const reg = registry();
      crawler(reg, 'idp').emits.contextTypes.push('User'); // User is a principal type, not a context type
      expect(run(reg)).toEqual(['crawler-type-undefined Context:User']);
    });
  });

  describe('ontology → manifest', () => {
    it('fails for an ia:emittedBy that names no crawler', () => {
      expect(run(registry(), `${CRAWLER_TTL}\nia:GroupOwnership ia:emittedBy "ghost" .`)).toEqual(['crawler-emitter-unknown ia:GroupOwnership']);
    });

    it('fails when the named crawler no longer declares the type', () => {
      const reg = registry();
      crawler(reg, 'hr').emits.resourceTypes = [];
      expect(run(reg)).toEqual(['crawler-emitter-stale ia:Group']);
    });
  });

  describe('passthrough', () => {
    it('fails when ia:passthroughFrom misses a crawler that passes values through', () => {
      const reg = registry();
      crawler(reg, 'idp').emits.open = ['resourceType'];
      const out = checkCrawlerTypes(modelOf(CRAWLER_TTL), reg);
      expect(out.map(f => `${f.code} ${f.subject}`)).toEqual(['crawler-passthrough-mismatch ia:Resource']);
      expect(out[0].message).toBe('ia:passthroughFrom lists hr; the manifests that pass resourceType through are hr, idp');
    });

    it('fails when ia:passthroughFrom names a crawler that does not, and says "none"/"nothing"', () => {
      const reg = registry();
      crawler(reg, 'hr').emits.open = [];
      const out = checkCrawlerTypes(modelOf(CRAWLER_TTL), reg);
      expect(out.map(f => f.message)).toEqual(['ia:passthroughFrom lists hr; the manifests that pass resourceType through are none']);
      const none = checkCrawlerTypes(modelOf(edit(CRAWLER_TTL, 'ia:Resource ia:passthroughFrom "hr" .', '')), registry());
      expect(none.map(f => f.message)).toEqual(['ia:passthroughFrom lists nothing; the manifests that pass resourceType through are hr']);
    });

    it('ignores a kind of node the ontology does not have', () => {
      // CONTEXT_TTL has Context; MINI-only models lack it — the Context row must not crash or report.
      const reg = registry();
      crawler(reg, 'hr').emits.open.push('contextType');
      expect(run(reg)).toEqual(['crawler-passthrough-mismatch ia:Context']);
    });
  });
});

describe('checkIntegrity — crawler annotations', () => {
  const findings = (ttl) => checkIntegrity(modelOf(ttl)).map(f => `${f.code} ${f.subject}`);

  it('rejects ia:emittedBy on a class that is not a type', () => {
    expect(findings(`${CRAWLER_TTL}\nia:ControlPermission ia:emittedBy "hr" .`)).toEqual(['emitted-by-misplaced ia:ControlPermission']);
  });

  it('rejects ia:passthroughFrom on a class without a discriminator', () => {
    expect(findings(`${CRAWLER_TTL}\nia:Group ia:passthroughFrom "hr" .`)).toEqual(['passthrough-misplaced ia:Group']);
  });
});
