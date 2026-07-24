import { useEffect } from 'react';
import { X } from 'lucide-react';
import ImageWithFallback from './ImageWithFallback';

export interface LightboxImage {
  src: string;
  alt?: string;
}

/**
 * Fullscreen image preview overlay. Render it with `image=null` when closed;
 * closes on backdrop click, the ✕ button, or Escape.
 */
export default function ImageLightbox({ image, onClose }: {
  image: LightboxImage | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!image) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [image, onClose]);

  if (!image) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-4 md:p-8"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute top-3 right-3 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition"
        aria-label="Close preview"
      >
        <X className="w-5 h-5" />
      </button>
      <ImageWithFallback
        src={image.src}
        alt={image.alt ?? ''}
        className="max-w-full max-h-full object-contain rounded shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
