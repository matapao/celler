// What a host writes to tell a review with its packet from one with its hash alone, through the package's own name and
// types: type-checked by records.test.mjs, never run.
import { isHashed, type ApprovalReview, type HashedReview, type PacketReview, type Write } from 'celler';

export function described(review: ApprovalReview): string {
  // @ts-expect-error: only a review of what never went says when that was
  void review.changedAt;
  if (isHashed(review)) return `${review.state} at ${review.changedAt}, sha256 ${review.write.sha256}`;
  const write: Write = review.write;
  return `${review.state}: ${write.operation} to ${write.destination}`;
}

export const packetOf = (review: PacketReview): Write => review.write;
export const changedAt = (review: HashedReview): number => review.changedAt;
