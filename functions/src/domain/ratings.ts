export interface RatingAggregate {
  count: number;
  total: number;
  average: number;
  contributions: Record<string, number>;
  updatedAt: number;
}

export function boundedRating(value: unknown): number {
  const rating = Number(value);
  return Number.isFinite(rating) && rating >= 1 && rating <= 5 ? rating : 0;
}

export function addRatingContribution(
  current: Partial<RatingAggregate> | null,
  contributionId: string,
  value: unknown,
  now = Date.now(),
): RatingAggregate | undefined {
  const rating = boundedRating(value);
  if (!rating) return undefined;
  const contributions = {...(current?.contributions ?? {})};
  if (Object.prototype.hasOwnProperty.call(contributions, contributionId)) return undefined;
  contributions[contributionId] = rating;
  const count = Math.max(0, Number(current?.count ?? 0)) + 1;
  const total = Math.max(0, Number(current?.total ?? 0)) + rating;
  return {count, total, average: Math.round((total / count) * 100) / 100, contributions, updatedAt: now};
}
