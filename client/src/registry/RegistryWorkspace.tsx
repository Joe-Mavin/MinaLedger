import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { apiRequest, type HoleReference, type SiteReference } from '../api';
import { WorkspaceHeading } from '../AppShell';

interface RoleGrant {
  roleCode: string;
  scopeKind: string;
  scopeId: string;
}

interface ParticipantCategory {
  participantKind: string;
  status: string;
  validFrom: string;
  validTo: string | null;
}

interface ParticipantRelationship {
  party_id: string;
  party_kind: 'PERSON' | 'ORGANISATION';
  display_name: string;
  relationship_id: string;
  relationship_kind: 'SITE' | 'HOLE';
  role_code: string;
  relationship_status: string;
  valid_from: string;
  valid_to: string | null;
  source_reference: string | null;
  evidence_ref: string | null;
  hole_id: string | null;
  participant_categories: ParticipantCategory[];
}

interface SiteDetail extends SiteReference {
  countyCode?: string | null;
  locality?: string | null;
  status?: string;
}

interface HoleDetail extends HoleReference {
  status?: string;
}

interface MutationIdentity {
  signature: string;
  id: string;
}

const PARTICIPANT_CATEGORIES = [
  'MINER', 'MINING_OPERATOR', 'LANDOWNER', 'PERMIT_HOLDER', 'DORA_OPERATOR', 'RECOVERY_FACILITY',
  'LOCAL_MERCHANT', 'LARGER_MERCHANT', 'CARRIER', 'FIELD_OFFICER', 'AUDITOR', 'OTHER',
];
const SITE_RELATIONSHIPS = ['LANDOWNER', 'PERMIT_HOLDER', 'SITE_OPERATOR', 'MINER', 'BENEFICIARY', 'FIELD_RECORDER', 'OTHER'];
const HOLE_RELATIONSHIPS = ['HOLE_OPERATOR', 'MINER', 'BENEFICIARY', 'FIELD_RECORDER', 'OTHER'];

function isoDateTime(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Enter a valid date and time.');
  return date.toISOString();
}

function readable(value: string): string {
  return value.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function displayDate(value?: string | null): string {
  if (!value) return 'Open ended';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function validationWindow(validFrom: string, validTo: string): string | null {
  if (!validFrom || !validTo) return null;
  const from = new Date(validFrom);
  const to = new Date(validTo);
  return Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from
    ? 'The end date must be later than the start date.' : null;
}

export function RegistryWorkspace({ token, roles, sites, onSiteSaved }: {
  token: string;
  roles: RoleGrant[];
  sites: SiteReference[];
  onSiteSaved: (site: SiteReference) => void;
}) {
  const [selectedSiteId, setSelectedSiteId] = useState('');
  const [siteDetail, setSiteDetail] = useState<SiteDetail | null>(null);
  const [holes, setHoles] = useState<HoleDetail[]>([]);
  const [participants, setParticipants] = useState<ParticipantRelationship[]>([]);
  const [selectedHoleId, setSelectedHoleId] = useState('');
  const [selectedHole, setSelectedHole] = useState<HoleDetail | null>(null);
  const [search, setSearch] = useState('');
  const [participantFilter, setParticipantFilter] = useState('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [showSiteForm, setShowSiteForm] = useState(false);
  const [showParticipantForm, setShowParticipantForm] = useState(false);
  const [editingSite, setEditingSite] = useState(false);
  const [busy, setBusy] = useState(false);
  const mutationIds = useRef<Record<string, MutationIdentity | undefined>>({});

  const [siteCode, setSiteCode] = useState('');
  const [siteName, setSiteName] = useState('');
  const [countyCode, setCountyCode] = useState('');
  const [locality, setLocality] = useState('');
  const [holeCode, setHoleCode] = useState('');
  const [holeName, setHoleName] = useState('');

  const [partyMode, setPartyMode] = useState<'new' | 'existing'>('new');
  const [partyKind, setPartyKind] = useState<'PERSON' | 'ORGANISATION'>('PERSON');
  const [displayName, setDisplayName] = useState('');
  const [organisationKind, setOrganisationKind] = useState('');
  const [existingPartyId, setExistingPartyId] = useState('');
  const [participantKind, setParticipantKind] = useState('MINER');
  const [relationshipKind, setRelationshipKind] = useState('MINER');
  const [relationshipHoleId, setRelationshipHoleId] = useState('');
  const [validFrom, setValidFrom] = useState('');
  const [validTo, setValidTo] = useState('');
  const [sourceReference, setSourceReference] = useState('');
  const [evidenceReference, setEvidenceReference] = useState('');

  const canCreateSite = roles.some((role) => role.roleCode === 'FIELD_OFFICER' && role.scopeKind === 'PILOT' && role.scopeId === 'default');
  const canManageSite = (siteId: string) => roles.some((role) =>
    (role.roleCode === 'FIELD_OFFICER' && role.scopeKind === 'PILOT' && role.scopeId === 'default')
    || (['FIELD_OFFICER', 'MINING_OPERATOR'].includes(role.roleCode) && role.scopeKind === 'SITE' && role.scopeId === siteId)
    || (['FIELD_OFFICER', 'MINING_OPERATOR'].includes(role.roleCode) && role.scopeKind === 'ORGANISATION'),
  );

  const mutationId = (operation: string, payload: unknown) => {
    const signature = JSON.stringify(payload);
    const previous = mutationIds.current[operation];
    if (previous?.signature === signature) return previous.id;
    const next = { signature, id: crypto.randomUUID() };
    mutationIds.current[operation] = next;
    return next.id;
  };

  const refreshSite = useCallback(async (siteId: string) => {
    if (!siteId) return;
    setLoading(true);
    setError('');
    try {
      const [detail, holeRows, participantRows] = await Promise.all([
        apiRequest<SiteDetail>(`/api/v1/sites/${siteId}`, token),
        apiRequest<HoleDetail[]>(`/api/v1/sites/${siteId}/holes`, token),
        apiRequest<ParticipantRelationship[]>(`/api/v1/sites/${siteId}/participants`, token),
      ]);
      setSiteDetail(detail);
      setHoles(holeRows);
      setParticipants(participantRows);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'The authorized site registry could not be loaded.');
      setSiteDetail(null);
      setHoles([]);
      setParticipants([]);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (!selectedSiteId && sites.length > 0) setSelectedSiteId(sites[0].id);
    if (selectedSiteId && !sites.some((site) => site.id === selectedSiteId)) {
      setSelectedSiteId('');
      setSiteDetail(null);
      setHoles([]);
      setParticipants([]);
      setSelectedHoleId('');
      setSelectedHole(null);
    }
  }, [sites, selectedSiteId]);

  useEffect(() => {
    if (!selectedSiteId) return;
    void refreshSite(selectedSiteId);
  }, [selectedSiteId, refreshSite]);

  useEffect(() => {
    if (!selectedHoleId) { setSelectedHole(null); return; }
    const hole = holes.find((row) => row.id === selectedHoleId);
    if (!hole || !selectedSiteId) return;
    let active = true;
    void apiRequest<HoleDetail>(`/api/v1/sites/${selectedSiteId}/holes/${selectedHoleId}`, token)
      .then((detail) => { if (active) setSelectedHole(detail); })
      .catch((loadError) => { if (active) setError(loadError instanceof Error ? loadError.message : 'Hole details could not be loaded.'); });
    return () => { active = false; };
  }, [selectedHoleId, selectedSiteId, holes, token]);

  const filteredSites = useMemo(() => sites.filter((site) => `${site.name} ${site.siteCode} ${'countyCode' in site ? site.countyCode ?? '' : ''} ${'locality' in site ? site.locality ?? '' : ''}`.toLowerCase().includes(search.toLowerCase().trim())), [sites, search]);
  const siteParticipants = useMemo(() => participants.filter((participant) => participantFilter === 'all' || participant.hole_id === participantFilter), [participants, participantFilter]);
  const uniqueParties = useMemo(() => {
    const map = new Map<string, ParticipantRelationship>();
    for (const participant of participants) if (!map.has(participant.party_id)) map.set(participant.party_id, participant);
    return [...map.values()];
  }, [participants]);

  function resetParticipantForm() {
    setPartyMode('new'); setPartyKind('PERSON'); setDisplayName(''); setOrganisationKind(''); setExistingPartyId('');
    setParticipantKind('MINER'); setRelationshipKind('MINER'); setRelationshipHoleId(''); setValidFrom(''); setValidTo('');
    setSourceReference(''); setEvidenceReference('');
  }

  async function createSite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = { siteCode: siteCode.trim(), name: siteName.trim(), ...(countyCode.trim() ? { countyCode: countyCode.trim() } : {}), ...(locality.trim() ? { locality: locality.trim() } : {}) };
    const requestId = mutationId('site.create', body);
    setBusy(true); setError(''); setMessage('');
    try {
      const created = await apiRequest<SiteDetail>('/api/v1/sites', token, { method: 'POST', headers: { 'Idempotency-Key': requestId }, body: JSON.stringify(body) });
      onSiteSaved(created);
      setSelectedSiteId(created.id);
      setSiteCode(''); setSiteName(''); setCountyCode(''); setLocality(''); setShowSiteForm(false);
      setMessage('Mining site registered. Its name and location are recorded as supplied.');
      mutationIds.current['site.create'] = undefined;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Site registration failed. Retry the unchanged request if its outcome is unknown.');
    } finally { setBusy(false); }
  }

  async function updateSite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!siteDetail) return;
    const body = { name: siteName.trim(), countyCode: countyCode.trim() || null, locality: locality.trim() || null };
    const requestId = mutationId(`site.update:${siteDetail.id}`, body);
    setBusy(true); setError(''); setMessage('');
    try {
      const updated = await apiRequest<SiteDetail>(`/api/v1/sites/${siteDetail.id}`, token, { method: 'PATCH', headers: { 'Idempotency-Key': requestId }, body: JSON.stringify(body) });
      onSiteSaved(updated);
      setSiteDetail(updated); setEditingSite(false);
      setMessage('Permitted site details updated. Site code is immutable.');
      mutationIds.current[`site.update:${siteDetail.id}`] = undefined;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Site update failed.');
    } finally { setBusy(false); }
  }

  async function createHole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!siteDetail) return;
    const body = { holeCode: holeCode.trim(), ...(holeName.trim() ? { name: holeName.trim() } : {}) };
    const requestId = mutationId(`hole.create:${siteDetail.id}`, body);
    setBusy(true); setError(''); setMessage('');
    try {
      const created = await apiRequest<HoleDetail>(`/api/v1/sites/${siteDetail.id}/holes`, token, { method: 'POST', headers: { 'Idempotency-Key': requestId }, body: JSON.stringify(body) });
      setHoles((current) => [...current.filter((hole) => hole.id !== created.id), created]);
      setHoleCode(''); setHoleName(''); setMessage(`Hole ${created.holeCode} registered under ${siteDetail.siteCode}.`);
      mutationIds.current[`hole.create:${siteDetail.id}`] = undefined;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Hole registration failed. The server verifies the site association.');
    } finally { setBusy(false); }
  }

  async function createParticipant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!siteDetail) return;
    const dateError = validationWindow(validFrom, validTo);
    if (dateError) { setError(dateError); return; }
    let from: string | undefined;
    let to: string | undefined;
    try { from = isoDateTime(validFrom); to = isoDateTime(validTo); }
    catch (dateErrorValue) { setError(dateErrorValue instanceof Error ? dateErrorValue.message : 'Enter valid relationship dates.'); return; }
    const body = {
      ...(partyMode === 'existing' ? { partyId: existingPartyId } : { partyKind, displayName: displayName.trim(), ...(partyKind === 'ORGANISATION' ? { organisationKind: organisationKind.trim() } : {}) }),
      participantKind,
      roleCode: relationshipKind,
      ...(relationshipHoleId ? { holeId: relationshipHoleId } : {}),
      ...(from ? { validFrom: from } : {}), ...(to ? { validTo: to } : {}),
      ...(sourceReference.trim() ? { sourceReference: sourceReference.trim() } : {}),
      ...(evidenceReference.trim() ? { evidenceRef: evidenceReference.trim() } : {}),
    };
    const requestId = mutationId(`participant.create:${siteDetail.id}`, body);
    setBusy(true); setError(''); setMessage('');
    try {
      const created = await apiRequest<{ partyId: string; relationshipId: string; displayName: string; participantKind: string; roleCode: string; holeId: string | null }>(`/api/v1/sites/${siteDetail.id}/participants`, token, { method: 'POST', headers: { 'Idempotency-Key': requestId }, body: JSON.stringify(body) });
      setMessage(`${created.displayName} registered as ${readable(created.participantKind)} and associated as ${readable(created.roleCode)}. No login account was created by this action.`);
      resetParticipantForm(); setShowParticipantForm(false);
      mutationIds.current[`participant.create:${siteDetail.id}`] = undefined;
      await refreshSite(siteDetail.id);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Participant registration failed. No login account is created by this action.');
    } finally { setBusy(false); }
  }

  return (
    <div className="registry-workspace">
      <WorkspaceHeading eyebrow="REGISTRY" title="Sites, holes and participants" description="Review only sites returned by the authenticated API. Participant identity, category and site or hole relationship remain separate records." />
      {error && <div className="notice error" role="alert">{error}</div>}
      {message && <div className="notice success" role="status">{message}</div>}
      <div className="registry-layout">
        <aside className="registry-list-panel" aria-label="Authorized mining sites">
          <div className="registry-list-head"><div><p className="eyebrow">AUTHORIZED REGISTER</p><h2>Mining sites <span className="count">{sites.length}</span></h2></div>
            {canCreateSite && <button className="small-button" type="button" onClick={() => { setShowSiteForm((visible) => !visible); setError(''); }}>Register site</button>}
          </div>
          <label className="registry-search">Search sites<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, code, county or locality" /></label>
          {sites.length === 0 ? <div className="empty-state">The server returned no sites for this account’s current grants.</div> : filteredSites.length === 0 ? <div className="empty-state">No site matches that search.</div> : <div className="registry-site-list">{filteredSites.map((site) => <button className={`registry-site-row ${site.id === selectedSiteId ? 'selected' : ''}`} key={site.id} type="button" onClick={() => { setSelectedSiteId(site.id); setSelectedHoleId(''); setParticipantFilter('all'); setError(''); setMessage(''); }}>
            <strong>{site.name}</strong><span>{site.siteCode}</span><small>{('countyCode' in site && site.countyCode) || ('locality' in site && site.locality) ? [site.countyCode, site.locality].filter(Boolean).join(' · ') : 'County/locality not recorded'}</small>
          </button>)}</div>}
          <p className="registry-policy">The site register does not infer land ownership or permit status. Only recorded participant relationships appear in the detail view.</p>
        </aside>

        <section className="registry-detail-panel" aria-label="Selected site registry details">
          {showSiteForm && <section className="capture-card registry-form" aria-labelledby="site-create-heading">
            <div className="section-heading"><div><p className="eyebrow">NEW SITE</p><h2 id="site-create-heading">Register a mining site</h2></div><button className="quiet" type="button" onClick={() => setShowSiteForm(false)}>Close</button></div>
            <form onSubmit={createSite} className="form-grid">
              <label>Site code<input value={siteCode} onChange={(event) => setSiteCode(event.target.value)} maxLength={80} required /></label>
              <label>Site name<input value={siteName} onChange={(event) => setSiteName(event.target.value)} maxLength={160} required /></label>
              <label>County code, if recorded<input value={countyCode} onChange={(event) => setCountyCode(event.target.value)} maxLength={80} /></label>
              <label>Locality, if recorded<input value={locality} onChange={(event) => setLocality(event.target.value)} maxLength={160} /></label>
              <p className="field-note span-two">The server permits site registration only to a pilot-scoped field officer. No ownership or permit data is created.</p>
              <div className="form-actions span-two"><button className="primary" type="submit" disabled={busy}>{busy ? 'Registering…' : 'Register site'}</button></div>
            </form>
          </section>}

          {!selectedSiteId && !showSiteForm && <div className="empty-state registry-empty">Choose an authorized site to view its recorded details, holes and participant relationships.</div>}
          {selectedSiteId && loading && <div className="empty-state" role="status">Loading authorized site details, holes and participant register…</div>}
          {selectedSiteId && !loading && !siteDetail && !showSiteForm && <div className="empty-state">Site details are unavailable. The API error is shown above; no local copy is presented as current.</div>}
          {siteDetail && !loading && <>
            <section className="queue-section registry-site-detail" aria-labelledby="site-detail-heading">
              <div className="registry-detail-heading"><div><p className="eyebrow">SITE RECORD</p><h2 id="site-detail-heading">{siteDetail.name}</h2><p className="muted">{siteDetail.siteCode} · {siteDetail.status ?? 'Status not returned'}</p></div>
                {canManageSite(siteDetail.id) && <button className="secondary" type="button" onClick={() => { setEditingSite((current) => !current); setSiteName(siteDetail.name); setCountyCode(siteDetail.countyCode ?? ''); setLocality(siteDetail.locality ?? ''); }}>Edit permitted details</button>}
              </div>
              {editingSite ? <form className="form-grid registry-form" onSubmit={updateSite}>
                <label>Site name<input value={siteName} onChange={(event) => setSiteName(event.target.value)} maxLength={160} required /></label>
                <label>County code<input value={countyCode} onChange={(event) => setCountyCode(event.target.value)} maxLength={80} /></label>
                <label>Locality<input value={locality} onChange={(event) => setLocality(event.target.value)} maxLength={160} /></label>
                <label>Site code<input value={siteDetail.siteCode} disabled /></label>
                <div className="form-actions span-two"><button className="secondary" type="button" onClick={() => setEditingSite(false)}>Cancel</button><button className="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save details'}</button></div>
              </form> : <dl className="registry-facts"><div><dt>Site code</dt><dd>{siteDetail.siteCode}</dd></div><div><dt>County</dt><dd>{siteDetail.countyCode || 'Not recorded'}</dd></div><div><dt>Locality</dt><dd>{siteDetail.locality || 'Not recorded'}</dd></div><div><dt>Site status</dt><dd>{siteDetail.status || 'Not returned by the API'}</dd></div></dl>}
            </section>

            <section className="queue-section" aria-labelledby="holes-heading">
              <div className="section-heading"><div><p className="eyebrow">SITE STRUCTURE</p><h2 id="holes-heading">Mining holes <span className="count">{holes.length}</span></h2></div></div>
              {canManageSite(siteDetail.id) && <form className="inline-register-form" onSubmit={createHole}>
                <label>Hole code<input value={holeCode} onChange={(event) => setHoleCode(event.target.value)} maxLength={80} required /></label>
                <label>Name, if used<input value={holeName} onChange={(event) => setHoleName(event.target.value)} maxLength={160} /></label>
                <button className="secondary" type="submit" disabled={busy || !holeCode.trim()}>{busy ? 'Adding…' : 'Register hole'}</button>
              </form>}
              {holes.length === 0 ? <div className="empty-state">No holes are recorded for this site.</div> : <div className="registry-hole-grid">{holes.map((hole) => <button key={hole.id} className={`registry-hole-card ${selectedHoleId === hole.id ? 'selected' : ''}`} type="button" onClick={() => { setSelectedHoleId(hole.id); setParticipantFilter(hole.id); }}>
                <strong>{hole.holeCode}</strong><span>{hole.name || 'No hole name recorded'}</span><small>{hole.status ?? 'Status not returned'} · {participants.filter((row) => row.hole_id === hole.id).length} recorded relationships</small>
              </button>)}</div>}
              {selectedHole && <div className="hole-detail-card"><div><p className="eyebrow">HOLE DETAIL</p><h3>{selectedHole.holeCode}</h3></div><dl className="registry-facts"><div><dt>Belongs to site</dt><dd>{siteDetail.name} ({siteDetail.siteCode})</dd></div><div><dt>Hole name</dt><dd>{selectedHole.name || 'Not recorded'}</dd></div><div><dt>Hole status</dt><dd>{selectedHole.status || 'Not returned by the API'}</dd></div><div><dt>Audit sequence</dt><dd>{selectedHole.auditSequence ?? 'Not returned'}</dd></div></dl></div>}
            </section>

            <section className="queue-section" aria-labelledby="participants-heading">
              <div className="section-heading"><div><p className="eyebrow">IDENTITY, CATEGORY AND RELATIONSHIP</p><h2 id="participants-heading">Participant register <span className="count">{siteParticipants.length}</span></h2></div>
                {canManageSite(siteDetail.id) && <button className="small-button" type="button" onClick={() => { setShowParticipantForm((visible) => !visible); setError(''); }}>Add participant relationship</button>}
              </div>
              <div className="register-filter"><label>Show relationships<select value={participantFilter} onChange={(event) => setParticipantFilter(event.target.value)}><option value="all">All site and hole relationships</option>{holes.map((hole) => <option key={hole.id} value={hole.id}>{hole.holeCode} relationships</option>)}</select></label></div>
              {showParticipantForm && <form className="capture-card participant-form" onSubmit={createParticipant} aria-labelledby="participant-create-heading">
                <div className="section-heading"><div><p className="eyebrow">NEW REGISTER ENTRY</p><h3 id="participant-create-heading">Record a participant and relationship</h3></div><button className="quiet" type="button" onClick={() => setShowParticipantForm(false)}>Close</button></div>
                <p className="field-note participant-separation">Identity, participant category and site/hole relationship are separate fields. This action does not create a login account or infer ownership or entitlement.</p>
                <div className="form-grid">
                  <label>Identity entry<select value={partyMode} onChange={(event) => setPartyMode(event.target.value as 'new' | 'existing')}><option value="new">Register a new person or organization</option><option value="existing" disabled={uniqueParties.length === 0}>Associate an identity already in this site's register</option></select></label>
                  {partyMode === 'existing' ? <label>Existing identity<select value={existingPartyId} onChange={(event) => setExistingPartyId(event.target.value)} required><option value="">Choose a recorded identity</option>{uniqueParties.map((party) => <option value={party.party_id} key={party.party_id}>{party.display_name} · {readable(party.party_kind)}</option>)}</select></label> : <>
                    <label>Identity kind<select value={partyKind} onChange={(event) => setPartyKind(event.target.value as 'PERSON' | 'ORGANISATION')}><option value="PERSON">Person</option><option value="ORGANISATION">Organization</option></select></label>
                    <label>{partyKind === 'PERSON' ? 'Person name' : 'Organization name'}<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={160} required /></label>
                    {partyKind === 'ORGANISATION' && <label>Organization kind<input value={organisationKind} onChange={(event) => setOrganisationKind(event.target.value)} maxLength={40} required /></label>}
                  </>}
                  <label>Participant category<select value={participantKind} onChange={(event) => setParticipantKind(event.target.value)}>{PARTICIPANT_CATEGORIES.map((kind) => <option value={kind} key={kind}>{readable(kind)}</option>)}</select></label>
                  <label>Relationship scope<select value={relationshipHoleId ? `HOLE:${relationshipHoleId}` : 'SITE'} onChange={(event) => { const value = event.target.value; setRelationshipHoleId(value.startsWith('HOLE:') ? value.slice(5) : ''); const rolesForScope = value.startsWith('HOLE:') ? HOLE_RELATIONSHIPS : SITE_RELATIONSHIPS; if (!rolesForScope.includes(relationshipKind)) setRelationshipKind(rolesForScope[0]); }}><option value="SITE">This mining site</option>{holes.map((hole) => <option value={`HOLE:${hole.id}`} key={hole.id}>{hole.holeCode}</option>)}</select></label>
                  <label>{relationshipHoleId ? 'Hole relationship' : 'Site relationship'}<select value={relationshipKind} onChange={(event) => setRelationshipKind(event.target.value)}>{(relationshipHoleId ? HOLE_RELATIONSHIPS : SITE_RELATIONSHIPS).map((role) => <option value={role} key={role}>{readable(role)}</option>)}</select></label>
                  <label>Valid from<input type="datetime-local" value={validFrom} onChange={(event) => setValidFrom(event.target.value)} /></label>
                  <label>Valid to, if known<input type="datetime-local" value={validTo} onChange={(event) => setValidTo(event.target.value)} min={validFrom || undefined} /></label>
                  <label>Source reference<input value={sourceReference} onChange={(event) => setSourceReference(event.target.value)} maxLength={255} /></label>
                  <label>Evidence reference<input value={evidenceReference} onChange={(event) => setEvidenceReference(event.target.value)} maxLength={255} /></label>
                </div>
                <div className="form-actions"><button className="primary" type="submit" disabled={busy || (partyMode === 'existing' && !existingPartyId)}>{busy ? 'Saving…' : 'Save participant relationship'}</button></div>
              </form>}
              {siteParticipants.length === 0 ? <div className="empty-state">No participant relationships are returned for this site/filter.</div> : <div className="participant-register-list">{siteParticipants.map((row) => <article className="participant-register-item" key={row.relationship_id}>
                <div className="participant-register-main"><div className="participant-title"><strong>{row.display_name}</strong><span className="state-pill">{readable(row.party_kind)}</span><span className="state-pill">{readable(row.relationship_kind)} relationship</span></div>
                  <p className="queue-meta">Party ID <code>{row.party_id}</code></p>
                  <p className="queue-meta">Participant category: {row.participant_categories?.length ? row.participant_categories.map((category) => `${readable(category.participantKind)} (${category.status.toLowerCase()}, ${displayDate(category.validFrom)} – ${displayDate(category.validTo)})`).join('; ') : 'No category detail returned by the API.'}</p>
                  <p className="queue-meta">Relationship: {readable(row.role_code)} · {row.relationship_status.toLowerCase()} · {row.hole_id ? holes.find((hole) => hole.id === row.hole_id)?.holeCode ?? row.hole_id : siteDetail.siteCode}</p>
                  <p className="queue-meta">Valid {displayDate(row.valid_from)} to {displayDate(row.valid_to)}</p>
                  {row.source_reference && <p className="queue-meta">Source: {row.source_reference}</p>}{row.evidence_ref && <p className="queue-meta">Evidence: {row.evidence_ref}</p>}
                </div>
              </article>)}</div>}
              <p className="registry-policy">Login account status is not included in the participant register API. Account creation is a separate administrator action and is never automatic from participant registration.</p>
            </section>
          </>}
        </section>
      </div>
    </div>
  );
}
