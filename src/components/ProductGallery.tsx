import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { getMecProductImageUrl } from '../lib/mecCatalog';

interface ProductGalleryProps {
  productId: string;
  mainImage: string;
}

export default function ProductGallery({ productId, mainImage }: ProductGalleryProps) {
  const [images, setImages] = useState<string[]>([mainImage]);
  const [currentImage, setCurrentImage] = useState(mainImage);
  const [loading, setLoading] = useState(true);
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function fetchProductImages() {
      setLoading(true);
      const { data, error } = await supabase
        .from('mec_product_images')
        .select('storage_path, display_order')
        .eq('product_id', productId)
        .order('display_order', { ascending: true });

      if (cancelled) return;

      if (error) {
        console.error('Error fetching MEC product images:', error);
        setImages([mainImage]);
        setCurrentImage(mainImage);
      } else {
        const imageUrls = (data ?? []).map((image) => getMecProductImageUrl(image.storage_path));
        const nextImages = imageUrls.length > 0 ? imageUrls : [mainImage];
        setImages(nextImages);
        setCurrentImage(nextImages[0]);
        setCurrentIndex(0);
      }
      setLoading(false);
    }

    if (productId) void fetchProductImages();
    else {
      setImages([mainImage]);
      setCurrentImage(mainImage);
      setLoading(false);
    }

    return () => { cancelled = true; };
  }, [productId, mainImage]);

  const setImageAt = (index: number) => {
    setCurrentIndex(index);
    setCurrentImage(images[index]);
  };

  const handlePrevious = () => setImageAt((currentIndex - 1 + images.length) % images.length);
  const handleNext = () => setImageAt((currentIndex + 1) % images.length);

  if (loading) {
    return <div className="bg-white dark:bg-gray-800 rounded-lg overflow-hidden shadow-lg flex items-center justify-center h-96"><div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary" /></div>;
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg overflow-hidden shadow-lg">
      <div className="relative">
        <img src={currentImage} alt="MEC product" className="w-full h-96 object-contain" />
        {images.length > 1 && (
          <>
            <button onClick={handlePrevious} className="absolute left-2 top-1/2 -translate-y-1/2 bg-white dark:bg-gray-800 rounded-full p-2 shadow-md hover:bg-gray-100 dark:hover:bg-gray-700" aria-label="Previous image"><ChevronLeft className="h-6 w-6 text-gray-600 dark:text-gray-300" /></button>
            <button onClick={handleNext} className="absolute right-2 top-1/2 -translate-y-1/2 bg-white dark:bg-gray-800 rounded-full p-2 shadow-md hover:bg-gray-100 dark:hover:bg-gray-700" aria-label="Next image"><ChevronRight className="h-6 w-6 text-gray-600 dark:text-gray-300" /></button>
          </>
        )}
      </div>
      {images.length > 1 && (
        <div className="flex justify-center mt-4 space-x-2 p-2">
          {images.map((image, index) => (
            <button key={image + index} onClick={() => setImageAt(index)} className={`h-16 w-16 rounded-md overflow-hidden border-2 transition-all ${currentIndex === index ? 'border-primary scale-110' : 'border-transparent opacity-70 hover:opacity-100'}`} aria-label={`Show image ${index + 1}`}>
              <img src={image} alt={`MEC product image ${index + 1}`} className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
