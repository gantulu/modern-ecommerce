import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ShoppingCart, ArrowLeft, Package, Check, Truck, Shield } from 'lucide-react';
import { useCartStore } from '../store/cartStore';
import { Product } from '../types/supabase';
import ProductGallery from '../components/ProductGallery';
import { fetchMecProducts } from '../lib/mecCatalog';

const formatIDR = (amount: number) => new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  maximumFractionDigits: 0,
}).format(amount);

export default function ProductDetail() {
  const { id } = useParams<{ id: string }>();
  const [product, setProduct] = useState<Product | null>(null);
  const [relatedProducts, setRelatedProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [addedToCart, setAddedToCart] = useState(false);

  const addItem = useCartStore((state) => state.addItem);
  const cartItems = useCartStore((state) => state.items);
  const updateQuantity = useCartStore((state) => state.updateQuantity);

  useEffect(() => {
    let cancelled = false;

    async function loadProduct() {
      setLoading(true);
      setLoadError(false);

      if (!id) {
        setProduct(null);
        setLoading(false);
        return;
      }

      const { products, error } = await fetchMecProducts();
      if (cancelled) return;

      if (error) {
        console.error('Error fetching MEC product detail:', error);
        setLoadError(true);
        setProduct(null);
      } else {
        const selectedProduct = products.find((item) => item.id === id) ?? null;
        setProduct(selectedProduct);
        setRelatedProducts(selectedProduct
          ? products.filter((item) => item.id !== id && selectedProduct.category_id && item.category_id === selectedProduct.category_id).slice(0, 4)
          : []);
      }
      setLoading(false);
    }

    void loadProduct();
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    if (!product) return;
    const cartItem = cartItems.find((item) => item.id === product.id);
    if (cartItem) {
      setQuantity(Math.min(cartItem.quantity, Math.max(product.stock, 1)));
      setAddedToCart(true);
    } else {
      setQuantity(1);
      setAddedToCart(false);
    }
  }, [cartItems, product]);

  const handleAddToCart = () => {
    if (!product || product.stock <= 0 || quantity > product.stock) return;

    const existingItem = cartItems.find((item) => item.id === product.id);
    if (existingItem) updateQuantity(product.id, quantity);
    else {
      addItem(product);
      if (quantity > 1) updateQuantity(product.id, quantity);
    }
    setAddedToCart(true);
  };

  if (loading) {
    return <div className="container py-10 flex justify-center"><div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary" /></div>;
  }

  if (loadError) {
    return <div className="container py-10 text-center"><p role="alert" className="text-red-600">Product details could not be loaded.</p><Link to="/products" className="text-primary hover:underline mt-4 inline-block">Back to Products</Link></div>;
  }

  if (!product) {
    return <div className="container py-10 text-center"><p className="text-gray-600 dark:text-gray-300">Product not found in the active MEC catalog.</p><Link to="/products" className="text-primary hover:underline mt-4 inline-block">Back to Products</Link></div>;
  }

  return (
    <div className="container py-10">
      <Link to="/products" className="text-primary hover:underline mb-6 inline-flex items-center"><ArrowLeft className="h-4 w-4 mr-2" />Back to Products</Link>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 mt-4">
        <ProductGallery productId={product.id} mainImage={product.image_url} />
        <div>
          <p className="text-sm uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">{product.category}</p>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">{product.name}</h1>
          <p className="text-2xl font-semibold text-primary mt-4">{formatIDR(product.price)}</p>
          <p className="text-gray-600 dark:text-gray-300 mt-6 whitespace-pre-line">{product.description || 'No product description has been added yet.'}</p>

          <div className="mt-6">
            {product.stock > 0 ? (
              <p className="text-green-600 dark:text-green-400">In stock: {product.stock}</p>
            ) : (
              <p className="text-red-600 dark:text-red-400">Out of stock</p>
            )}
          </div>

          <div className="flex items-center gap-4 mt-6">
            <span className="text-gray-700 dark:text-gray-300">Quantity</span>
            <div className="flex items-center border border-gray-300 dark:border-gray-600 rounded-md">
              <button onClick={() => setQuantity((value) => Math.max(1, value - 1))} disabled={quantity <= 1} className="px-3 py-2 disabled:opacity-40" aria-label="Decrease quantity">−</button>
              <span className="px-4 py-2">{quantity}</span>
              <button onClick={() => setQuantity((value) => Math.min(product.stock, value + 1))} disabled={quantity >= product.stock} className="px-3 py-2 disabled:opacity-40" aria-label="Increase quantity">+</button>
            </div>
          </div>

          <button onClick={handleAddToCart} disabled={product.stock <= 0 || quantity > product.stock} className="mt-6 w-full flex items-center justify-center gap-2 bg-primary text-white py-3 rounded-md hover:bg-magenta-600 transition-colors disabled:cursor-not-allowed disabled:bg-gray-400">
            {addedToCart ? <Check className="h-5 w-5" /> : <ShoppingCart className="h-5 w-5" />}
            <span>{product.stock <= 0 ? 'Out of Stock' : addedToCart ? 'Update Cart' : 'Add to Cart'}</span>
          </button>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-8 text-sm text-gray-600 dark:text-gray-300">
            <div className="flex items-center gap-2"><Package className="h-5 w-5" /><span>MEC catalog item</span></div>
            <div className="flex items-center gap-2"><Truck className="h-5 w-5" /><span>Shipping details at checkout</span></div>
            <div className="flex items-center gap-2"><Shield className="h-5 w-5" /><span>Secure payment flow</span></div>
          </div>
        </div>
      </div>

      {relatedProducts.length > 0 && (
        <section className="mt-16">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-6">Related Products</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-6">
            {relatedProducts.map((relatedProduct) => (
              <Link key={relatedProduct.id} to={`/products/${relatedProduct.id}`} className="bg-white dark:bg-gray-800 rounded-lg shadow-md overflow-hidden transform transition duration-300 hover:scale-105">
                <img src={relatedProduct.image_url} alt={relatedProduct.name} className="w-full h-48 object-cover" loading="lazy" />
                <div className="p-4">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{relatedProduct.name}</h3>
                  <p className="text-primary font-medium mt-2">{formatIDR(relatedProduct.price)}</p>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
