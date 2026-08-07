import { Cron } from 'croner';

const INVALID_SCHEDULE_MESSAGE = 'Schedule must use a valid five-field cron pattern.';

export function parsePeriodicJobSchedule(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ');

  if (normalized.split(' ').length !== 5) {
    throw new Error(INVALID_SCHEDULE_MESSAGE);
  }

  try {
    const validator = new Cron(normalized, { paused: true });
    validator.stop();
    return normalized;
  } catch {
    throw new Error(INVALID_SCHEDULE_MESSAGE);
  }
}
