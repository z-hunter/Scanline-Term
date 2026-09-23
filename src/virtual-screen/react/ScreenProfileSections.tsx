import type { ReactNode } from 'react';
import type { ScreenMode, ScreenProfile } from '../profile';

export function ScreenProfileSections({ profile, modes, onChange, children }: {
  profile: ScreenProfile;
  modes: readonly ScreenMode[];
  onChange: (profile: ScreenProfile) => void;
  children?: ReactNode;
}) {
  return <>
    {modes.length > 1 && <label className="resolution-control">
      Virtual resolution
      <select data-testid="resolution-select" value={profile.virtualScreen.modeId} onChange={(event) => onChange({ ...profile, virtualScreen: { modeId: event.target.value } })}>
        {modes.map((mode) => <option key={mode.id} value={mode.id}>{mode.label ?? mode.id}</option>)}
      </select>
    </label>}
    {children}
  </>;
}
