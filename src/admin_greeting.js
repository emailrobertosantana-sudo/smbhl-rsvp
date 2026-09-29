// How admin-only emails greet the admin. They were hard-coded to
// "Roberto" -- wrong for anyone else who runs or inherits the admin
// inbox. The name comes from the ADMIN_NAME variable when it is set;
// otherwise the greeting has no name ("Bonjour," / "Hi,").
export function adminName(env) {
  return String((env && env.ADMIN_NAME) || '').trim();
}
export function adminHello(env, lang) {
  const n = adminName(env);
  return lang === 'fr' ? `Bonjour${n ? ' ' + n : ''},` : `Hi${n ? ' ' + n : ''},`;
}
