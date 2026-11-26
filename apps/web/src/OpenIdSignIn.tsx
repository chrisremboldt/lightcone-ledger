import React from 'react';
import type { ConfirmIdentity } from './SmsApp.js';
import type { SignInConfiguration } from '@ledger/contracts';
import { Button, Mark, Notice, Spinner } from '@ledger/ui';
import {
  beginSignIn,
  completeSignIn,
  confirmAccountTied,
  endSession,
  OpenIdSession,
  readSignInConfiguration,
  SignInError,
  UntiedAccountError,
  type IssuerEntry,
} from './openid-connect.js';
import { goTo } from './place.js';
import { WaitingOnDevice } from './DeviceOutbox.js';

export interface SignedIn {
  token: () => Promise<string | null>;
  account: React.ReactNode;
  /** Absent for a development token, which confirms a signature with the token itself. */
  confirmIdentity?: ConfirmIdentity;
  sessionKey: string;
  /** Signed in with a development token, on an API that reports it runs for one computer (LEDGER_ENV=local). */
  local?: boolean;
}

/** The sign-in screen of a deployment: its own name and one way in. Nothing fictional appears here. */
export function DeploymentGate({
  name,
  local = false,
  children,
}: {
  name?: string;
  local?: boolean;
  children: React.ReactNode;
}) {
  return (
    <main className="gate gate--deployment">
      <header className="gate-brand">
        <Mark size={22} />
        <span>LEDGER</span>
      </header>
      <div className="gate-body gate-body--single">
        <section className="gate-panel">
          {name && <h1 className="gate-deployment-name">{name}</h1>}
          {children}
          <WaitingOnDevice />
        </section>
      </div>
      <footer className="gate-foot">{local && <span>Local development</span>}</footer>
    </main>
  );
}

/**
 * Opens the organization with a development token, on an API that reports it accepts them: one started for a single
 * computer with LEDGER_ENV=local, such as infra/compose.try.yaml. The API decides; with LEDGER_ENV=staging it reports
 * none, this is not shown, and the API refuses such a token anyway.
 */
export function DevelopmentTokenSignIn({
  open,
  checking,
  onOpen,
}: {
  open: boolean;
  checking: boolean;
  onOpen: (token: string) => void;
}) {
  const [token, setToken] = React.useState('');
  const entered = token.trim();
  return (
    <details className="local-token" open={open}>
      <summary>Use a development token</summary>
      <form
        className="local-token-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (entered) onOpen(entered);
        }}
      >
        <label className="local-person-choice" htmlFor="development-token">
          <span id="development-token-label">Development token</span>
          <input
            id="development-token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            aria-labelledby="development-token-label"
            aria-describedby="development-token-description"
          />
          <small id="development-token-description">
            Yours: the one create-organization printed when your organization was made, or one an administrator issued
            you on the People screen. Ledger is running for this computer only, so it accepts development tokens.
          </small>
        </label>
        <Button kind={open ? 'primary' : 'secondary'} type="submit" disabled={!entered || checking}>
          Open with this token
        </Button>
      </form>
    </details>
  );
}

/** The ways in the sign-in screen offers, from what the API reported: its providers, and development tokens if any. */
export function SignInChoices({
  configuration,
  starting,
  onStart,
  onDevelopmentToken,
}: {
  configuration: SignInConfiguration;
  starting: boolean;
  onStart: (entry: IssuerEntry) => void;
  onDevelopmentToken: (token: string) => void;
}) {
  const issuers = configuration.issuers;
  return (
    <>
      {issuers.length === 0 && !configuration.developmentTokens ? (
        <Notice title="Sign-in is not configured">
          This deployment has no sign-in provider yet. Its administrator sets LEDGER_OIDC_ISSUER and
          LEDGER_OIDC_CLIENT_ID for the API.
        </Notice>
      ) : issuers.length > 0 ? (
        <div className="gate-sign-in">
          {issuers.map((entry) => (
            <Button
              key={entry.issuer}
              kind="primary"
              disabled={starting || !entry.authorizationEndpoint}
              onClick={() => onStart(entry)}
            >
              {issuers.length === 1 ? 'Sign in' : `Sign in with ${entry.label}`}
            </Button>
          ))}
          {issuers.some((entry) => !entry.authorizationEndpoint) && (
            <small className="gate-note">
              The sign-in provider cannot be reached right now. Reload the page to try again.
            </small>
          )}
        </div>
      ) : null}
      {configuration.developmentTokens && (
        <DevelopmentTokenSignIn open={issuers.length === 0} checking={starting} onOpen={onDevelopmentToken} />
      )}
    </>
  );
}

// The provider's answer is used once; a second mount (React's development double effects) shares the first result.
let completion: ReturnType<typeof completeSignIn> | null = null;

const message = (error: unknown) =>
  error instanceof SignInError ? error.message : 'Sign-in did not complete. Try again.';

/**
 * Signs a person in through the deployment's OpenID Connect provider and keeps their session in memory. A reload
 * returns to the sign-in screen; the provider's own session usually signs them straight back in.
 */
export function OpenIdSignIn({
  apiUrl,
  workspace,
}: {
  apiUrl: string;
  workspace: (signedIn: SignedIn) => React.ReactNode;
}) {
  const [configuration, setConfiguration] = React.useState<SignInConfiguration | null>(null);
  const [session, setSession] = React.useState<OpenIdSession | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [completing, setCompleting] = React.useState(true);
  const [untied, setUntied] = React.useState<{ error: UntiedAccountError; signOut: () => void } | null>(null);
  const [developmentToken, setDevelopmentToken] = React.useState<string | null>(null);
  const sessions = React.useRef(0);

  React.useEffect(() => {
    let stopped = false;
    void (async () => {
      try {
        const read = await readSignInConfiguration(apiUrl);
        if (stopped) return;
        setConfiguration(read);
        const done = await (completion ??= completeSignIn(read));
        if (stopped || !done) return;
        try {
          await confirmAccountTied(apiUrl, done.tokens.idToken);
        } catch (error) {
          if (!(error instanceof UntiedAccountError)) throw error;
          if (!stopped) setUntied({ error, signOut: () => endSession(done.entry, done.tokens.idToken) });
          return;
        }
        if (stopped) return;
        sessions.current++;
        setSession(
          new OpenIdSession(done.entry, done.tokens, (reason) => {
            setSession(null);
            setProblem(reason);
          }),
        );
      } catch (error) {
        if (!stopped) setProblem(message(error));
      } finally {
        if (!stopped) setCompleting(false);
      }
    })();
    return () => {
      stopped = true;
    };
  }, [apiUrl]);

  if (untied)
    return (
      <DeploymentGate name={configuration?.deploymentName}>
        <Notice tone="alert" title="This account is not tied to anyone in Ledger">
          {untied.error.message}
        </Notice>
        <dl className="gate-account">
          <dt>Sign-in provider (issuer)</dt>
          <dd>
            <code>{untied.error.issuer}</code>
          </dd>
          <dt>Account (subject)</dt>
          <dd>
            <code>{untied.error.subject}</code>
          </dd>
        </dl>
        <div className="gate-sign-in">
          <Button onClick={untied.signOut}>Sign out</Button>
        </div>
      </DeploymentGate>
    );
  if (developmentToken) {
    const token = developmentToken;
    return workspace({
      token: async () => token,
      sessionKey: `development-${sessions.current}`,
      local: true,
      account: (
        <Button
          onClick={() => {
            // The next person to sign in starts at the first screen, not at a place this one opened.
            goTo({ section: 'start' }, { replace: true });
            setDevelopmentToken(null);
          }}
        >
          Sign out
        </Button>
      ),
    });
  }
  if (session)
    return workspace({
      token: session.token,
      confirmIdentity: session.confirm,
      sessionKey: `session-${sessions.current}`,
      account: (
        <Button
          onClick={() => {
            const ending = session;
            goTo({ section: 'start' }, { replace: true });
            setSession(null);
            endSession(ending.entry, ending.idToken);
          }}
        >
          Sign out
        </Button>
      ),
    });
  if (completing || !configuration)
    return (
      <DeploymentGate name={configuration?.deploymentName}>
        {problem ? (
          <Notice tone="alert" title="Sign-in is unavailable">
            {problem}
          </Notice>
        ) : (
          <Spinner label="Signing in" />
        )}
      </DeploymentGate>
    );
  const start = async (entry: IssuerEntry) => {
    setStarting(true);
    setProblem(null);
    try {
      await beginSignIn(entry);
    } catch (error) {
      setProblem(message(error));
      setStarting(false);
    }
  };
  // The token is checked before the workspace opens, so a mistyped one is said here rather than on every screen.
  const openWithToken = async (token: string) => {
    setStarting(true);
    setProblem(null);
    try {
      const response = await fetch(`${apiUrl.replace(/\/$/, '')}/v1/me`, {
        headers: { authorization: `Bearer ${token}` },
        credentials: 'omit',
        cache: 'no-store',
      });
      if (response.ok) {
        sessions.current++;
        setDevelopmentToken(token);
      } else
        setProblem(
          response.status === 401
            ? 'Ledger did not accept this development token. Check that it is the whole token, and that no one has issued you a newer one.'
            : 'Ledger cannot be reached. Try again shortly.',
        );
    } catch {
      setProblem('Ledger cannot be reached. Try again shortly.');
    } finally {
      setStarting(false);
    }
  };
  return (
    <DeploymentGate name={configuration.deploymentName} local={configuration.developmentTokens}>
      {problem && (
        <Notice tone="alert" title="Not signed in">
          {problem}
        </Notice>
      )}
      <SignInChoices
        configuration={configuration}
        starting={starting}
        onStart={(entry) => void start(entry)}
        onDevelopmentToken={(token) => void openWithToken(token)}
      />
    </DeploymentGate>
  );
}
