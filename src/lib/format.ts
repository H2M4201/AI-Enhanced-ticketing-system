/** The host of a Jira site URL, for display. A value that does not parse is shown as it is. */
export function siteHost(siteUrl: string): string {
  try {
    return new URL(siteUrl).host;
  } catch {
    return siteUrl;
  }
}
