// The window-skip rule (6ed0ee8) now lives in the shared reminder module,
// src/reminders.js, moved there verbatim. Re-exported here so every existing
// importer (leagues.js, index.js, tests) keeps the exact same functions.
export { REMINDER_WINDOW_THRESHOLD_HOURS, applyReminderWindowSkipRule } from './reminders.js';
