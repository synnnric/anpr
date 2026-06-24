import { useEffect, useState } from 'react';
import placeholder from '../assets/image-placeholder.svg';

type Props = Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  src?: string | null;
};

/**
 * <img> that falls back to a bundled placeholder graphic when the source is
 * missing (null / empty) or fails to load — e.g. the real capture (face image,
 * UVIS scan) hasn't been uploaded by the device yet. The placeholder is shown
 * "contained" and dimmed so the slot reads as empty rather than as a broken
 * image. The fallback asset is bundled, so it works offline (air-gapped sites).
 */
export default function ImageWithFallback({ src, alt = '', className, style, ...rest }: Props) {
  const [failed, setFailed] = useState(false);

  // A given <img> instance can be reused for a new src across renders; reset the
  // error flag whenever the source changes so a fresh URL gets a fair attempt.
  useEffect(() => setFailed(false), [src]);

  const usePlaceholder = failed || !src;

  return (
    <img
      {...rest}
      src={usePlaceholder ? placeholder : (src as string)}
      alt={alt}
      className={className}
      onError={() => setFailed(true)}
      style={usePlaceholder
        ? { objectFit: 'contain', padding: '18%', opacity: 0.5, ...style }
        : style}
    />
  );
}
