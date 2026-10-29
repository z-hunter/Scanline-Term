export type ShellInfo = { id?: string; name: string; command: string; args?: string[] };

export function shellIdentity(shell: ShellInfo): string {
  return shell.id ?? shell.command;
}

export function resolveShellLaunch(defaultShell: string, shells: ShellInfo[], explicit?: { command?: string | null; args?: string[]; cwd?: string | null }): { command: string | null; args?: string[]; cwd?: string | null } | null {
  if (explicit?.command) return { ...explicit, command: explicit.command };
  if (!defaultShell) return explicit ? { ...explicit, command: null } : null;
  const shell = shells.find((item) => shellIdentity(item) === defaultShell);
  if (shell) return { ...(explicit ?? {}), command: shell.command, ...(!('args' in (explicit ?? {})) && shell.args?.length ? { args: shell.args } : {}) };
  if (defaultShell.startsWith('lua:')) throw new Error(`Default shell is unavailable: ${defaultShell}`);
  return { ...(explicit ?? {}), command: defaultShell };
}

export function splitShellCatalog(shells: ShellInfo[]): { automatic: ShellInfo[]; user: ShellInfo[] } {
  return { automatic: shells.filter((shell) => !shell.id?.startsWith('lua:')), user: shells.filter((shell) => shell.id?.startsWith('lua:')) };
}
