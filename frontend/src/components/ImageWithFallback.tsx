import { useEffect, useState } from 'react';
import genericPlaceholder from '../assets/image-placeholder.svg';

type Props = Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  src?: string | null;
  /** Placeholder shown when src is missing or fails to load. Defaults to a
   *  generic "photo" graphic; pass a context-specific dummy (face, UVIS, …). */
  fallback?: string;
  /** Notified whenever the placeholder is shown/hidden. Lets a parent suppress
   *  overlays (e.g. UVIS coord boxes) that only make sense on the real image.
   *  Pass a stable callback (e.g. a useState setter) to avoid re-render loops. */
  onFallbackChange?: (usingFallback: boolean) => void;
};

/**
 * <img> that falls back to a bundled dummy image when the source is missing
 * (null / empty) or fails to load — e.g. the real capture hasn't been uploaded
 * by the device yet. The dummy assets are full-bleed graphics designed to read
 * as a real photo, so they fill the slot using the caller's className (object-
 * cover etc.) just like the real image would. Bundled, so they work offline.
 */
export default function ImageWithFallback({
  src, alt = '', fallback = genericPlaceholder, onFallbackChange, className, ...rest
}: Props) {
  const [failed, setFailed] = useState(false);

  // An <img> instance can be reused for a new src across renders; reset the
  // error flag whenever the source changes so a fresh URL gets a fair attempt.
  useEffect(() => setFailed(false), [src]);

  const usePlaceholder = failed || !src;

  useEffect(() => { onFallbackChange?.(usePlaceholder); }, [usePlaceholder, onFallbackChange]);

  return (
    <img
      {...rest}
      src={usePlaceholder ? fallback : (src as string)}
      alt={alt}
      className={className}
      onError={() => setFailed(true)}
    />
  );
}
