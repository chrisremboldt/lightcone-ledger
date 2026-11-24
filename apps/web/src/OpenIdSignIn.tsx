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

export interface SignedIn {
  token: () => Promise<string | null>;
  account: React.ReactNode;
  confirmIdentity: ConfirmIdentity;
  sessionKey: string;
}

/** The sign-in screen of a deployment: its own name and one way in. Nothing fictional appears here. */
export function DeploymentGate({ name, children }: { name?: string; children: React.ReactNode }) {
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
        </section>
      </div>
      <footer className="gate-foot" />
    </main>
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
  if (session)
    return workspace({
      token: session.token,
      confirmIdentity: session.confirm,
      sessionKey: `session-${sessions.current}`,
      account: (
        <Button
          onClick={() => {
            const ending = session;
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
  const issuers = configuration.issuers;
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
  return (
    <DeploymentGate name={configuration.deploymentName}>
      {problem && (
        <Notice tone="alert" title="Not signed in">
          {problem}
        </Notice>
      )}
      {issuers.length === 0 ? (
        <Notice title="Sign-in is not configured">
          This deployment has no sign-in provider yet. Its administrator sets LEDGER_OIDC_ISSUER and
          LEDGER_OIDC_CLIENT_ID for the API.
        </Notice>
      ) : (
        <div className="gate-sign-in">
          {issuers.map((entry) => (
            <Button
              key={entry.issuer}
              kind="primary"
              disabled={starting || !entry.authorizationEndpoint}
              onClick={() => void start(entry)}
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
      )}
    </DeploymentGate>
  );
}
