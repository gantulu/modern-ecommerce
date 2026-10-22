import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Filter } from 'lucide-react';
import { useCartStore } from '../store/cartStore';
import ProductCard from '../components/ProductCard';
import QuickView from '../components/QuickView';
import { Product } from '../types/supabase';
import { fetchMecCategories, fetchMecProducts } from '../lib/mecCatalog';

const formatIDR = (amount: number) => new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  maximumFractionDigits: 0,
}).format(amount);

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [priceRange, setPriceRange] = useState<[number, number]>([0, 1]);
  const [maxPrice, setMaxPrice] = useState(1);
  const [showFilters, setShowFilters] = useState(false);
  const [sortBy, setSortBy] = useState('');
  const [quickViewProduct, setQuickViewProduct] = useState<Product | null>(null);
  const [isQuickViewOpen, setIsQuickViewOpen] = useState(false);

  const addItem = useCartStore((state) => state.addItem);
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const searchQuery = (searchParams.get('search') || '').trim();
  const categoryParam = searchParams.get('category') || '';

  useEffect(() => {
    setSelectedCategory(categoryParam);
  }, [categoryParam]);

  useEffect(() => {
    let cancelled = false;

    async function loadCatalog() {
      setLoading(true);
      setErrorMessage('');

      const [productResult, categoryResult] = await Promise.all([
        fetchMecProducts(),
        fetchMecCategories(),
      ]);

      if (cancelled) return;

      if (productResult.error) {
        console.error('Error fetching MEC products:', productResult.error);
        setErrorMessage('Products could not be loaded. Please try again later.');
        setProducts([]);
      } else {
        const activeProducts = productResult.products;
        const highestPrice = activeProducts.reduce((highest, product) => Math.max(highest, product.price), 0);
        setProducts(activeProducts);
        setMaxPrice(Math.max(highestPrice, 1));
        setPriceRange([0, Math.max(highestPrice, 1)]);
      }

      if (categoryResult.error) {
        console.error('Error fetching MEC categories:', categoryResult.error);
        setCategories([]);
      } else {
        setCategories(categoryResult.categories.map((category) => category.name));
      }

      setLoading(false);
    }

    void loadCatalog();
    return () => { cancelled = true; };
  }, []);

  const filteredProducts = useMemo(() => {
    let result = products.filter((product) => {
      const matchesCategory = !selectedCategory || product.category === selectedCategory;
      const matchesPrice = product.price >= priceRange[0] && product.price <= priceRange[1];
      const normalizedSearch = searchQuery.toLocaleLowerCase();
      const matchesSearch = !normalizedSearch
        || product.name.toLocaleLowerCase().includes(normalizedSearch)
        || product.description.toLocaleLowerCase().includes(normalizedSearch);
      return matchesCategory && matchesPrice && matchesSearch;
    });

    if (sortBy === 'price-asc') result = [...result].sort((a, b) => a.price - b.price);
    else if (sortBy === 'price-desc') result = [...result].sort((a, b) => b.price - a.price);
    else if (sortBy === 'newest') result = [...result].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

    return result;
  }, [products, selectedCategory, priceRange, searchQuery, sortBy]);

  const resetFilters = () => {
    setSelectedCategory('');
    setPriceRange([0, maxPrice]);
    setSortBy('');
  };

  return (
    <div className="container mx-auto py-10">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
          {searchQuery ? `Search Results for "${searchQuery}"` : selectedCategory || 'All Products'}
        </h1>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className="flex items-center space-x-2 bg-gray-100 dark:bg-gray-700 px-4 py-2 rounded-lg md:hidden"
        >
          <Filter className="h-5 w-5" />
          <span>Filters</span>
        </button>
      </div>

      <div className="flex flex-col md:flex-row gap-6">
        <aside className={`md:w-1/4 ${showFilters ? 'block' : 'hidden md:block'} transition-all duration-300`}>
          <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-md sticky top-4">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Filters</h2>
              <button onClick={resetFilters} className="text-sm text-primary hover:underline">Reset</button>
            </div>

            <div className="mb-6">
              <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-3">Categories</h3>
              <div className="space-y-2">
                <label className="flex items-center">
                  <input type="radio" name="category" checked={selectedCategory === ''} onChange={() => setSelectedCategory('')} className="h-4 w-4 accent-primary" />
                  <span className="ml-2 text-gray-700 dark:text-gray-300">All Categories</span>
                </label>
                {categories.map((category) => (
                  <label key={category} className="flex items-center">
                    <input type="radio" name="category" checked={selectedCategory === category} onChange={() => setSelectedCategory(category)} className="h-4 w-4 accent-primary" />
                    <span className="ml-2 text-gray-700 dark:text-gray-300">{category}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="mb-6">
              <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-3">Price Range (IDR)</h3>
              <div className="space-y-4">
                <div className="flex justify-between gap-2 text-sm text-gray-700 dark:text-gray-300">
                  <span>{formatIDR(priceRange[0])}</span>
                  <span>{formatIDR(priceRange[1])}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max={maxPrice}
                  value={Math.min(priceRange[1], maxPrice)}
                  onChange={(event) => setPriceRange([0, Number(event.target.value)])}
                  className="w-full accent-primary"
                  aria-label="Maximum product price in IDR"
                />
              </div>
            </div>

            <div>
              <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-3">Sort By</h3>
              <select
                value={sortBy}
                onChange={(event) => setSortBy(event.target.value)}
                className="w-full p-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:border-primary focus:ring-primary"
              >
                <option value="">Trending</option>
                <option value="price-asc">Price: Low to High</option>
                <option value="price-desc">Price: High to Low</option>
                <option value="newest">Newest First</option>
              </select>
            </div>
          </div>
        </aside>

        <div className="md:w-3/4">
          {loading ? (
            <div className="flex justify-center items-center h-64">
              <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary" />
            </div>
          ) : errorMessage ? (
            <p role="alert" className="text-center py-10 text-red-600">{errorMessage}</p>
          ) : filteredProducts.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredProducts.map((product) => (
                <div key={product.id} className="transform-gpu">
                  <ProductCard
                    product={product}
                    onAddToCart={addItem}
                    onQuickView={(selectedProduct) => {
                      setQuickViewProduct(selectedProduct);
                      setIsQuickViewOpen(true);
                    }}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-10">
              <p className="text-gray-600 dark:text-gray-300">No products found in the MEC catalog.</p>
            </div>
          )}
        </div>
      </div>

      {isQuickViewOpen && quickViewProduct && (
        <QuickView product={quickViewProduct} onClose={() => setIsQuickViewOpen(false)} />
      )}
    </div>
  );
}
