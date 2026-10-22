import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Package } from 'lucide-react';
import { fetchMecCategories, fetchMecProducts, MecCategory } from '../lib/mecCatalog';

type CategoryWithCount = MecCategory & { count: number };

export default function Categories() {
  const [categories, setCategories] = useState<CategoryWithCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function loadCategories() {
      const [categoryResult, productResult] = await Promise.all([fetchMecCategories(), fetchMecProducts()]);
      if (cancelled) return;

      if (categoryResult.error || productResult.error) {
        console.error('Error loading MEC categories:', categoryResult.error ?? productResult.error);
        setErrorMessage('Product categories could not be loaded.');
        setCategories([]);
      } else {
        const counts = new Map<string, number>();
        productResult.products.forEach((product) => {
          if (product.category_id) counts.set(product.category_id, (counts.get(product.category_id) ?? 0) + 1);
        });
        setCategories(categoryResult.categories.map((category) => ({ ...category, count: counts.get(category.id) ?? 0 })));
      }
      setLoading(false);
    }

    void loadCategories();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <div className="container py-10 flex justify-center"><div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary" /></div>;
  }

  return (
    <div className="container py-10">
      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-8">Product Categories</h1>
      {errorMessage ? (
        <p role="alert" className="text-center py-10 text-red-600">{errorMessage}</p>
      ) : categories.length === 0 ? (
        <p className="text-center py-10 text-gray-600 dark:text-gray-300">No active MEC categories yet.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {categories.map((category, index) => (
            <Link
              key={category.id}
              to={`/products?category=${encodeURIComponent(category.name)}`}
              className="bg-white dark:bg-gray-800 rounded-lg shadow-md overflow-hidden transform transition-all duration-500 ease-in-out hover:scale-105 hover:shadow-xl will-change-transform"
              style={{ animationDelay: `${index * 100}ms`, animation: 'fadeInUp 0.6s ease-out forwards' }}
            >
              <div className="relative h-48 overflow-hidden bg-gradient-to-br from-primary/20 to-secondary/30 flex items-center justify-center">
                <Package className="h-16 w-16 text-primary/70" aria-hidden="true" />
                <div className="absolute inset-0 bg-black/10 flex items-center justify-center">
                  <h2 className="text-2xl font-bold text-gray-900 dark:text-white drop-shadow-sm">{category.name}</h2>
                </div>
              </div>
              <div className="p-4">
                <p className="text-gray-600 dark:text-gray-300">{category.count} {category.count === 1 ? 'product' : 'products'}</p>
                <p className="mt-2 text-primary transition-all">Browse Category →</p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
