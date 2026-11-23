// Date selection uses the original order day, including subsequent collections.
export const operatingHistorySummariesSql = `
  SELECT summary FROM mbox.operating_day_summaries($1,$2,$3::date,$4::date) ORDER BY business_day`
