export const PERIODIC_JOB_SUMMARY_MAX_LENGTH = 2_000;

export function capPeriodicJobSummary(value: string): string {
  return value.length <= PERIODIC_JOB_SUMMARY_MAX_LENGTH
    ? value
    : `${value.slice(0, PERIODIC_JOB_SUMMARY_MAX_LENGTH - 1)}…`;
}
