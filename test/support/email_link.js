// What a person does with an email's answer link now: open it (a GET,
// which records nothing -- link scanners open every URL), then press the
// confirmation page's button (a form POST). Returns the confirmation
// page's HTML, the POST response, and the page it leads to.
//   fetcher(url, init) -> Response  (SELF.fetch, or a worker.fetch wrapper)
export async function answerViaEmailLink(fetcher, url) {
  const confirmHtml = await (await fetcher(url)).text();
  const form = confirmHtml.match(/<form method="post" action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/);
  if (!form) throw new Error(`no confirmation form at ${url}:\n${confirmHtml.slice(0, 400)}`);
  const action = form[1].replace(/&amp;/g, '&');
  const fields = new URLSearchParams();
  for (const m of form[2].matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields.set(m[1], m[2]);
  const base = new URL(url);
  const postRes = await fetcher(new URL(action, base).toString(), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: fields.toString(), redirect: 'manual'
  });
  let finalHtml = '';
  const loc = postRes.headers.get('location');
  if (postRes.status === 303 && loc) finalHtml = await (await fetcher(new URL(loc, base).toString())).text();
  else finalHtml = await postRes.text();
  return { confirmHtml, postRes, finalHtml };
}
