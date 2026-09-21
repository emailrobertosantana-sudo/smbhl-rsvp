async function fetchReviewIndex() {
  const res = await fetch('https://rsvp.smbhl.com/admin/review');
  const text = await res.text();
  const ids = [...text.matchAll(/\/admin\/review\?id=([a-zA-Z0-9_\-]+)/g)].map(m => m[1]);
  console.log('Review IDs found:', ids);
  if (ids.length > 0) {
    const detailRes = await fetch('https://rsvp.smbhl.com/admin/review?id=' + ids[0]);
    const detailHtml = await detailRes.text();
    // find reviewData in the script
    const dataMatch = detailHtml.match(/const initialReview\s*=\s*(\{[\s\S]*?\});\s*const/);
    if (dataMatch) {
      console.log('Found initialReview length:', dataMatch[1].length);
      const fs = await import('fs');
      fs.writeFileSync('initialReview.json', dataMatch[1]);
    } else {
      console.log('Could not find initialReview in HTML, looking for extracted_json or games:');
      const m2 = detailHtml.match(/allParsedSheets|extracted_json/);
      console.log('Found keywords?', !!m2);
    }
  }
}
fetchReviewIndex();

