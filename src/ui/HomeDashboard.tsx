import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';

export type HomeLink = { title: string; url: string; shortcut?: string };
export type HomeCategory = { title: string; links: HomeLink[] };
export type HomeConfig = { version: 1; title: string; categories: HomeCategory[] };
type HomePayload = { path: string; config: HomeConfig };
type HomeHint = { element: HTMLElement; label: string; rect: DOMRect };
let cachedHome: HomePayload | null = null;
const loadedHomeTabs = new Set<string>();
const hintLabels = 'asdfghjkl';

const hintLabelAt = (index: number, total: number) => {
  let width = 1;
  let capacity = hintLabels.length;
  while (total > capacity) { width += 1; capacity *= hintLabels.length; }
  let label = '';
  for (let place = width - 1; place >= 0; place -= 1) label += hintLabels[Math.floor(index / hintLabels.length ** place) % hintLabels.length];
  return label;
};

const defaultHomeConfig = (): HomeConfig => ({
  version: 1,
  title: 'Scanline Home',
  categories: [{ title: 'Development', links: [
    { title: 'GitHub', url: 'https://github.com/', shortcut: 'g' },
    { title: 'Tauri Docs', url: 'https://v2.tauri.app/', shortcut: 't' },
  ] }],
});

const urlValue = (value: string) => {
  const candidate = /^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`;
  const parsed = new URL(candidate);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('URL must use http or https');
  return parsed.toString();
};

const isLikelyUrl = (value: string) => /^https?:\/\//i.test(value) || /^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:\/.*)?$/i.test(value);

const promptValue = (label: string, initial: string) => {
  const value = window.prompt(label, initial);
  return value === null ? null : value.trim();
};

export function HomeDashboard({ tabId, onNavigate, onError }: { tabId: string; onNavigate: (id: string, url: string) => void; onError: (message: string) => void }) {
  const [config, setConfig] = useState<HomeConfig | null>(null);
  const [path, setPath] = useState('');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hints, setHints] = useState<{ entries: HomeHint[]; typed: string } | null>(null);
  const homeRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (force = false) => {
    if (!force && loadedHomeTabs.has(tabId) && cachedHome) {
      setConfig(cachedHome.config);
      setPath(cachedHome.path);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const payload = isTauri() ? await invoke<HomePayload>('load_home_config') : { path: 'browser preview', config: defaultHomeConfig() };
      cachedHome = payload;
      loadedHomeTabs.add(tabId);
      setConfig(payload.config);
      setPath(payload.path);
    } catch (reason) {
      const message = String(reason);
      setError(message);
      onError(message);
    } finally {
      setLoading(false);
    }
  }, [onError, tabId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key === 'F6' || (event.code === 'KeyO' && !event.ctrlKey && !event.altKey && !event.metaKey && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement))) {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', focusSearch, true);
    return () => window.removeEventListener('keydown', focusSearch, true);
  }, []);

  const save = async (next: HomeConfig) => {
    try {
      const payload = isTauri() ? await invoke<HomePayload>('save_home_config', { config: next }) : { path, config: next };
      cachedHome = payload;
      loadedHomeTabs.add(tabId);
      setConfig(payload.config);
      setPath(payload.path);
      setError('');
      return true;
    } catch (reason) {
      const message = String(reason);
      setError(message);
      onError(message);
      return false;
    }
  };

  const links = useMemo(() => config?.categories.flatMap((category, categoryIndex) => category.links.map((link, linkIndex) => ({ category, categoryIndex, link, linkIndex }))) ?? [], [config]);
  const visibleLinks = links.filter(({ category, link }) => {
    const needle = query.trim().toLocaleLowerCase();
    return !needle || `${category.title} ${link.title} ${link.url}`.toLocaleLowerCase().includes(needle);
  });
  const open = (value: string) => {
    try { onNavigate(tabId, urlValue(value)); return true; } catch (reason) { setError(String(reason)); return false; }
  };
  const collectHints = useCallback(() => {
    const root = homeRef.current;
    if (!root) return [];
    const items = Array.from(root.querySelectorAll<HTMLElement>('a[href],button,input,textarea,select,[role="button"]')).filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
    });
    return items.map((element, index) => ({ element, label: hintLabelAt(index, items.length), rect: element.getBoundingClientRect() }));
  }, []);
  const showHints = useCallback(() => setHints({ entries: collectHints(), typed: '' }), [collectHints]);
  useEffect(() => {
    const openShortcut = (event: KeyboardEvent) => {
      if (event.key === 'F5') { event.preventDefault(); setHints(null); return; }
      if (event.ctrlKey || event.altKey || event.metaKey || event.repeat) return;
      if (hints) {
        if (event.key === 'Escape') { event.preventDefault(); setHints(null); return; }
        const key = event.key.toLocaleLowerCase();
        if (!hintLabels.includes(key)) return;
        event.preventDefault();
        const typed = `${hints.typed}${key}`;
        const matches = hints.entries.filter(({ label }) => label.startsWith(typed));
        if (matches.length === 1 && matches[0].label === typed) {
          setHints(null);
          matches[0].element.focus();
          matches[0].element.click();
        } else if (!matches.length) setHints(null);
        else setHints({ entries: hints.entries, typed });
        return;
      }
      const editable = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || (event.target instanceof HTMLElement && event.target.isContentEditable);
      if (event.key.toLocaleLowerCase() === 'f' && !editable) { event.preventDefault(); showHints(); return; }
      if (editable || (event.target instanceof Element && event.target.closest('button'))) return;
      const shortcut = event.key.toLocaleLowerCase();
      const link = links.find(({ link: item }) => item.shortcut?.toLocaleLowerCase() === shortcut)?.link;
      if (!link) return;
      event.preventDefault();
      onNavigate(tabId, link.url);
    };
    window.addEventListener('keydown', openShortcut, true);
    return () => window.removeEventListener('keydown', openShortcut, true);
  }, [hints, links, onNavigate, showHints, tabId]);
  useEffect(() => {
    if (!hints) return;
    const root = homeRef.current;
    const refresh = () => setHints((current) => current ? { ...current, entries: collectHints() } : current);
    window.addEventListener('resize', refresh);
    root?.addEventListener('scroll', refresh);
    return () => { window.removeEventListener('resize', refresh); root?.removeEventListener('scroll', refresh); };
  }, [collectHints, hints]);
  const submitSearch = () => {
    const value = query.trim();
    if (!value) return;
    if (isLikelyUrl(value)) { open(value); return; }
    const first = visibleLinks[0]?.link;
    if (first) open(first.url);
  };
  const update = (mutate: (current: HomeConfig) => HomeConfig) => { if (config) void save(mutate(config)); };
  const addCategory = () => {
    const title = promptValue('Category name', 'New category');
    if (title) update((current) => ({ ...current, categories: [...current.categories, { title, links: [] }] }));
  };
  const renameCategory = (index: number) => {
    if (!config) return;
    const title = promptValue('Category name', config.categories[index].title);
    if (title) update((current) => ({ ...current, categories: current.categories.map((category, item) => item === index ? { ...category, title } : category) }));
  };
  const addLink = (categoryIndex: number) => {
    const title = promptValue('Link title', 'New link');
    const url = title && promptValue('Link URL', 'https://') ;
    const shortcut = title && url && promptValue('Shortcut (optional)', '');
    if (!title || !url) return;
    try {
      const normalized = urlValue(url);
      update((current) => ({ ...current, categories: current.categories.map((category, index) => index === categoryIndex ? { ...category, links: [...category.links, { title, url: normalized, ...(shortcut ? { shortcut: shortcut.toLowerCase() } : {}) }] } : category) }));
    } catch (reason) { setError(String(reason)); }
  };
  const editLink = (categoryIndex: number, linkIndex: number) => {
    if (!config) return;
    const link = config.categories[categoryIndex].links[linkIndex];
    const title = promptValue('Link title', link.title);
    const url = title && promptValue('Link URL', link.url);
    const shortcut = title && url && promptValue('Shortcut (optional)', link.shortcut ?? '');
    if (!title || !url) return;
    try {
      const normalized = urlValue(url);
      update((current) => ({ ...current, categories: current.categories.map((category, index) => index !== categoryIndex ? category : { ...category, links: category.links.map((item, itemIndex) => itemIndex === linkIndex ? { title, url: normalized, ...(shortcut ? { shortcut: shortcut.toLowerCase() } : {}) } : item) }) }));
    } catch (reason) { setError(String(reason)); }
  };
  const removeLink = (categoryIndex: number, linkIndex: number) => {
    if (!window.confirm('Delete this link?')) return;
    update((current) => ({ ...current, categories: current.categories.map((category, index) => index !== categoryIndex ? category : { ...category, links: category.links.filter((_, itemIndex) => itemIndex !== linkIndex) }) }));
  };
  const removeCategory = (index: number) => {
    if (!window.confirm('Delete this category and its links?')) return;
    update((current) => ({ ...current, categories: current.categories.filter((_, itemIndex) => itemIndex !== index) }));
  };
  const reset = () => {
    if (window.confirm('Replace the home file with the default example?')) void save(defaultHomeConfig());
  };

  return (
    <section ref={homeRef} className="browser-home" aria-label="Scanline home page" data-hint-mode={hints ? 'active' : undefined} onPointerDown={() => hints && setHints(null)}>
      <header className="browser-home-header">
        <div><p className="browser-home-kicker">SCANLINE TERM // HOME</p><h1>{config?.title ?? 'Scanline Home'}</h1></div>
        <div className="browser-home-actions">
          <button type="button" onClick={() => void load(true)} disabled={loading}>Reload</button>
          <button type="button" onClick={() => setEditing((value) => !value)} disabled={!config}>{editing ? 'Done' : 'Edit'}</button>
        </div>
      </header>
      <form className="browser-home-search" onSubmit={(event) => { event.preventDefault(); submitSearch(); }}>
        <label htmlFor="home-search">Search links or open URL</label>
        <input ref={searchRef} id="home-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Type to filter, or enter an URL" autoFocus />
        <button type="submit">Open</button>
      </form>
      {loading && <p className="browser-home-status">Loading home.json…</p>}
      {error && <div className="browser-home-error" role="alert"><span>{error}</span><button type="button" onClick={reset}>Use default</button></div>}
      {!loading && config && <div className="browser-home-grid">
        {config.categories.map((category, categoryIndex) => {
          const categoryLinks = visibleLinks.filter((item) => item.categoryIndex === categoryIndex);
          return <section className="browser-home-category" key={`${category.title}-${categoryIndex}`}>
            <div className="browser-home-category-title"><h2>{category.title}</h2>{editing && <span><button type="button" onClick={() => renameCategory(categoryIndex)}>Rename</button><button type="button" onClick={() => removeCategory(categoryIndex)}>Delete</button></span>}</div>
            <div className="browser-home-links">
              {categoryLinks.map(({ link, linkIndex }) => <div className="browser-home-link" key={`${link.url}-${linkIndex}`}>
                <button type="button" className="browser-home-link-open" onClick={() => open(link.url)}><span>{link.title}</span><small>{link.url}</small></button>
                {link.shortcut && <kbd>{link.shortcut}</kbd>}
                {editing && <span className="browser-home-link-edit"><button type="button" onClick={() => editLink(categoryIndex, linkIndex)}>Edit</button><button type="button" onClick={() => removeLink(categoryIndex, linkIndex)}>Delete</button></span>}
              </div>)}
              {editing && <button type="button" className="browser-home-add" onClick={() => addLink(categoryIndex)}>+ Add link</button>}
              {!categoryLinks.length && !editing && <p className="browser-home-empty">No matching links.</p>}
            </div>
          </section>;
        })}
        {editing && <button type="button" className="browser-home-add-category" onClick={addCategory}>+ Add category</button>}
      </div>}
      {hints?.entries.map(({ label, rect }) => label.startsWith(hints.typed) && <span className="browser-home-hint" key={label} style={{ left: rect.left, top: rect.top }}>{label}</span>)}
      <footer className="browser-home-footer">{path || 'Local home configuration'} · F shows keyboard hints · Esc closes hints</footer>
    </section>
  );
}
