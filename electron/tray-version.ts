export interface TrayVersionCopy {
  label: string;
  tooltip: string;
}

export function trayVersionCopy(version: string, updateWaiting: boolean): TrayVersionCopy {
  const label = `Hornbook ${version}`;
  return {
    label,
    tooltip: updateWaiting ? `${label} · update available` : label,
  };
}
