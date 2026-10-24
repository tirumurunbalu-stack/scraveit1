import {storage, LEGACY_MEDIA_BUCKET} from "../admin";

type MediaFile = ReturnType<ReturnType<typeof storage.bucket>["file"]>;

/**
 * An uploaded object in the Mumbai bucket. App builds from before the move
 * upload to the old US bucket, so if it isn't here yet but is there, it is
 * copied across first (same bytes and metadata) and the Mumbai copy returned.
 */
export async function mediaFile(path: string): Promise<MediaFile> {
  const file = storage.bucket().file(path);
  const [exists] = await file.exists();
  if (exists) return file;
  const legacy = storage.bucket(LEGACY_MEDIA_BUCKET).file(path);
  const [there] = await legacy.exists().catch(() => [false] as [boolean]);
  if (there) await legacy.copy(file);
  return file;
}

/** Deletes an object from both buckets, so erasing it leaves no copy behind. */
export async function deleteMediaEverywhere(path: string): Promise<void> {
  await Promise.all([storage.bucket(), storage.bucket(LEGACY_MEDIA_BUCKET)]
    .map((bucket) => bucket.file(path).delete().catch(() => undefined)));
}
