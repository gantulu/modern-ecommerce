import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShoppingCart } from 'lucide-react';
import { useCartStore } from '../store/cartStore';
import type { Product } from '../types/supabase';
import { fetchMecProducts } from '../lib/mecCatalog';

const formatIDR = (amount: number) => new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  maximumFractionDigits: 0,
}).format(amount);

export default function FeaturedProducts() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const addItem = useCartStore((state) => state.addItem);
  const cartItems = useCartStore((state) => state.items);

  useEffect(() => {
    let cancelled = false;

    async function loadFeaturedProducts() {
      const { products: catalogProducts, error } = await fetchMecProducts();
      if (cancelled) return;

      if (error) {
        console.error('Error fetching MEC featured products:', error);
        setLoadError(true);
        setProducts([]);
      } else {
        setProducts(catalogProducts.slice(0, 3));
      }
      setLoading(false);
    }

    void loadFeaturedProducts();
    return () => { cancelled = true; };
  }, []);

  const handleAddToCart = (event: React.MouseEvent, product: Product) => {
    event.preventDefault();
    event.stopPropagation();
    const existingItem = cartItems.find((item) => item.id === product.id);
    if (existingItem) useCartStore.getState().updateQuantity(product.id, existingItem.quantity + 1);
    else addItem(product);
  };

  const isInCart = (productId: string) => cartItems.some((item) => item.id === productId);

  if (loading) {
    return (
      <div className="mt-16 w-full">
        <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-8">Featured Products</h2>
        <div className="flex justify-center"><div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary" /></div>
      </div>
    );
  }

  return (
    <div className="mt-16 w-full">
      <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-8">Featured Products</h2>
      {loadError ? (
        <p role="alert" className="text-center text-red-600">Featured products could not be loaded.</p>
      ) : products.length === 0 ? (
        <p className="text-center text-gray-600 dark:text-gray-300">No featured products in the MEC catalog yet.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {products.map((product) => (
            <Link
              key={product.id}
              to={`/products/${product.id}`}
              className="bg-white dark:bg-gray-800 rounded-lg shadow-md overflow-hidden transform transition duration-300 hover:scale-105 flex flex-col h-full"
            >
              <div className="relative">
                <img src={product.image_url} alt={product.name} className="w-full h-48 object-cover" loading="lazy" />
                <div className="absolute top-0 right-0 bg-secondary text-gray-800 px-2 py-1 m-2 rounded-md text-sm font-medium">{formatIDR(product.price)}</div>
              </div>
              <div className="p-4 flex flex-col flex-grow">
                <h3 className="text-xl font-semibold text-gray-900 dark:text-white">{product.name}</h3>
                <p className="text-gray-600 dark:text-gray-300 mt-2 flex-grow">
                  {product.description.substring(0, 60)}{product.description.length > 60 ? '...' : ''}
                </p>
                <button
                  onClick={(event) => handleAddToCart(event, product)}
                  disabled={product.stock <= 0}
                  className="mt-4 w-full flex items-center justify-center space-x-2 bg-primary text-white py-2 rounded-md hover:bg-magenta-600 transition-colors btn-hover-scale disabled:cursor-not-allowed disabled:bg-gray-400"
                >
                  <ShoppingCart className="w-5 h-5" />
                  <span>{product.stock <= 0 ? 'Out of Stock' : isInCart(product.id) ? 'Update Cart' : 'Add to Cart'}</span>
                </button>
              </div>
            </Link>
          ))}
        </div>
      )}
      <div className="mt-8 text-center">
        <Link to="/products" className="inline-block px-6 py-3 bg-primary text-white rounded-md hover:bg-magenta-600 transition-colors btn-hover-scale btn-hover-shadow">View all products</Link>
      </div>
    </div>
  );
}
