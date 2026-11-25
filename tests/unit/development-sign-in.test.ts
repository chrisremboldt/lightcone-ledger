import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SignInConfiguration } from '../../packages/contracts/src/index.js';
import { DeploymentGate, SignInChoices } from '../../apps/web/src/OpenIdSignIn.js';
import { developmentSignInNotice } from '../../apps/api/src/openid-connect.js';

// React is a dependency of the web app only, so it resolves from there.
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = webRequire('react') as typeof import('react');
const { renderToStaticMarkup } = webRequire('react-dom/server') as typeof import('react-dom/server');

const root = fileURLToPath(new URL('../../', import.meta.url));
const issuer = {
  issuer: 'https://id.example.test/realms/ledger',
  clientId: 'ledger-web',
  label: 'Example ID',
  authorizationEndpoint: 'https://id.example.test/realms/ledger/auth',
  tokenEndpoint: 'https://id.example.test/realms/ledger/token',
};

/** The sign-in screen the production web build shows for what the API reported at GET /v1/sign-in. */
function screen(configuration: SignInConfiguration): string {
  return renderToStaticMarkup(
    createElement(
      DeploymentGate,
      { name: configuration.deploymentName, local: configuration.developmentTokens },
      createElement(SignInChoices, {
        configuration,
        starting: false,
        onStart: () => undefined,
        onDevelopmentToken: () => undefined,
      }),
    ),
  );
}

describe('development sign-in in the production web build', () => {
  it('is not offered when the API runs with LEDGER_ENV=staging', () => {
    for (const issuers of [[issuer], []]) {
      const shown = screen({ deploymentName: 'Example Ridge Survey', issuers, developmentTokens: false });
      expect(shown).not.toContain('Use a development token');
      expect(shown).not.toContain('Development token');
      expect(shown).not.toContain('Local development');
    }
    expect(screen({ deploymentName: 'Ledger', issuers: [], developmentTokens: false })).toContain(
      'Sign-in is not configured',
    );
  });

  it('is offered, open, under the Local development marker when the API reports LEDGER_ENV=local', () => {
    const shown = screen({ deploymentName: 'Ledger', issuers: [], developmentTokens: true });
    expect(shown).toContain('<summary>Use a development token</summary>');
    expect(shown).toContain('<details class="local-token" open="">');
    expect(shown).toContain('<span>Local development</span>');
    expect(shown).not.toContain('Sign-in is not configured');
  });

  it('is offered beside a configured provider, closed, when the API reports LEDGER_ENV=local', () => {
    const shown = screen({ deploymentName: 'Ledger', issuers: [issuer], developmentTokens: true });
    expect(shown).toContain('>Sign in</button>');
    expect(shown).toContain('<details class="local-token">');
    expect(shown).toContain('<summary>Use a development token</summary>');
  });
});

describe('the API at start', () => {
  it('says in one line that development sign-in is on and that this is not a start for a server', () => {
    expect(developmentSignInNotice('staging')).toBeUndefined();
    for (const env of ['local', 'test'] as const) {
      const notice = developmentSignInNotice(env)!;
      expect(notice).toContain(`Development sign-in is on (LEDGER_ENV=${env})`);
      expect(notice).toContain('not a start for a server');
      expect(notice).not.toContain('\n');
    }
  });
});

describe('the start for trying Ledger', () => {
  const read = (path: string) => readFileSync(join(root, path), 'utf8');

  it('is the only compose file that runs Ledger with LEDGER_ENV=local, and the image keeps staging', () => {
    const files = readdirSync(join(root, 'infra')).filter((name) => /^compose.*\.ya?ml$/.test(name));
    expect(files).toContain('compose.try.yaml');
    for (const file of files)
      expect(/LEDGER_ENV:\s*local\b|LEDGER_ENV=local\b/.test(read(`infra/${file}`)), file).toBe(
        file === 'compose.try.yaml',
      );
    expect(read('infra/Dockerfile')).toMatch(/^ENV NODE_ENV=production LEDGER_ENV=staging /m);
  });

  it('publishes ports on this computer’s own address only', () => {
    const text = read('infra/compose.try.yaml');
    const published = [...text.matchAll(/^\s*ports:\s*\[(.*)\]\s*$/gm)].flatMap((match) =>
      match[1]!.split(',').map((entry) => entry.trim().replace(/^'|'$/g, '')),
    );
    expect(published.length).toBeGreaterThan(0);
    for (const entry of published) expect(entry).toMatch(/^127\.0\.0\.1:/);
    expect(text).not.toMatch(/^\s*ports:\s*$/m);
  });
});
