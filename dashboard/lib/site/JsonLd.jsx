/**
 * Structured data (schema.org JSON-LD) for search engines. `<` is escaped so no string in the
 * data can close the script element.
 */
export function JsonLd({ data }) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
