import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type Tone = 'neutral' | 'planned' | 'observed' | 'advisory' | 'attention' | 'alert';

export function Badge({ children, tone = 'neutral', title }: { children: ReactNode; tone?: Tone; title?: string }) {
  return (
    <span className={`badge badge--${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Button({
  children,
  className = '',
  kind = 'secondary',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'next' | 'secondary' | 'quiet' }) {
  return (
    <button className={`button button--${kind} ${className}`} {...props}>
      {children}
    </button>
  );
}

export function Notice({ children, tone = 'attention', title }: { children: ReactNode; tone?: Tone; title?: string }) {
  return (
    <div className={`notice notice--${tone}`} role={tone === 'alert' ? 'alert' : 'status'}>
      {title && <strong>{title}</strong>}
      <div>{children}</div>
    </div>
  );
}

export function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={(size * 18) / 20} viewBox="0 0 20 18" fill="none" aria-hidden="true">
      <path d="M10 1L19 17H1Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M10 7.5L14 15H6Z" fill="#e2008c" />
    </svg>
  );
}

export function Arrow({ direction = 'right' }: { direction?: 'right' | 'left' | 'down' }) {
  return (
    <svg
      className={`arrow arrow--${direction}`}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3 8H13M9 4L13 8L9 12"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span className="loading-status" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </span>
  );
}
