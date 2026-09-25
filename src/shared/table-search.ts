import {canonicalTableCode} from './table-code-alias'

/** Resolve once across the visible, authorized data before testing individual rows. */
export function tableSearchMatcher(query:string,tableCodes:readonly (string|null|undefined)[]) {
  const needle=query.trim().toUpperCase()
  const codes=tableCodes.filter((code):code is string=>!!code).map(code=>code.toUpperCase())
  const canonical=canonicalTableCode(needle)
  const exact=codes.find(code=>code===needle)??codes.find(code=>code===canonical)
    // A known roster-shaped code must not match a random ID even when that
    // table has no work in the current queue. Numeric product names stay searchable.
    ??(/^(?:VIP|BAR|[WDCBAGLS])0*[1-9][0-9]*$/.test(needle)?canonical:null)
  return (code:string|null|undefined,...text:(string|null|undefined)[])=>exact!==null
    ? code?.toUpperCase()===exact
    : needle===''||[code,...text].some(value=>value?.toUpperCase().includes(needle))
}
