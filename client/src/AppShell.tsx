import type { ReactNode } from 'react';
import { getNavigationItems, type WorkspaceSection } from './navigation';

interface RoleOption {
  key: string;
  roleCode: string;
  scopeKind: string;
  scopeId: string;
}

interface AppShellProps {
  userName: string;
  roles: RoleOption[];
  selectedRoleKey: string;
  section: WorkspaceSection;
  online: boolean;
  onSelectRole: (roleKey: string) => void;
  onNavigate: (section: WorkspaceSection) => void;
  onSignOut: () => void;
  children: ReactNode;
}

function scopeLabel(role: RoleOption | undefined): string {
  if (!role) return 'No active role assignment';
  const scope = role.scopeKind.toLowerCase().replaceAll('_', ' ');
  return `${role.roleCode.replaceAll('_', ' ')} · ${scope} ${role.scopeId}`;
}

export function AppShell({ userName, roles, selectedRoleKey, section, online, onSelectRole, onNavigate, onSignOut, children }: AppShellProps) {
  const activeRole = roles.find((role) => role.key === selectedRoleKey);
  const navigation = getNavigationItems(activeRole?.roleCode);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <header className="topbar">
        <a className="brand" href="#overview" onClick={(event) => { event.preventDefault(); onNavigate('overview'); }} aria-label="MinaLedger overview">
          <span className="brand-mark small" aria-hidden="true">M</span>
          <span>MinaLedger <small>KENYA OPERATIONS</small></span>
        </a>
        <div className="top-actions">
          <span className={`connection ${online ? 'online' : 'offline'}`} role="status"><i />{online ? 'Online' : 'Offline'}</span>
          <span className="header-context" aria-label={`Current acting role and scope: ${scopeLabel(activeRole)}`}>{scopeLabel(activeRole)}</span>
          <span className="signed-in-user">{userName}</span>
          <button className="quiet" type="button" onClick={onSignOut}>Sign out</button>
        </div>
      </header>
      <div className="app-frame">
        <aside className="side-rail" aria-label="Workspace controls">
          <div className="acting-context">
            <label htmlFor="acting-role">Acting role and scope</label>
            <select id="acting-role" aria-label="Acting role and scope" value={selectedRoleKey} onChange={(event) => onSelectRole(event.target.value)} disabled={roles.length === 0}>
              {roles.length === 0 && <option value="">No active role</option>}
              {roles.map((role) => <option key={role.key} value={role.key}>{scopeLabel(role)}</option>)}
            </select>
            <p>Authorization is checked by the server for every request and sync.</p>
          </div>
          <nav className="primary-navigation" aria-label="Workspace navigation">
            <p className="nav-heading">Workspace</p>
            {navigation.map((item) => (
              <button key={item.id} type="button" className={`nav-item ${section === item.id ? 'active' : ''}`} aria-current={section === item.id ? 'page' : undefined} onClick={() => onNavigate(item.id)}>
                <span className={`nav-glyph nav-${item.id}`} aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
          <div className="rail-note"><span className="label">Signed in as</span><strong>{userName}</strong><span className="scope-summary">{scopeLabel(activeRole)}</span></div>
        </aside>
        <main className="workspace" id="main-content" tabIndex={-1}>
          {children}
          <footer><span>Session-only sign-in</span><span>Local browser storage is not encrypted</span><span>Server checks current role and account status</span></footer>
        </main>
      </div>
    </div>
  );
}

export function WorkspaceHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return (
    <section className="welcome-row">
      <div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="muted">{description}</p></div>
      {action}
    </section>
  );
}
