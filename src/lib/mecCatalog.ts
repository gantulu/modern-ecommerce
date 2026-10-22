import { supabase } from './supabase';
import type { Product, Category } from '../types/supabase';

const MEC_PRODUCT_IMAGE_BUCKET = 'mec-products';
const PRODUCT_PLACEHOLDER = '/product-placeholder.svg';

export function getMecProductImageUrl(storagePath: string): string {
  return supabase.storage.from(MEC_PRODUCT_IMAGE_BUCKET).getPublicUrl(storagePath).data.publicUrl;
}

type MecProductRow = {
  id: string;
  category_id: string | null;
  name: string;
  slug: string;
  description: string | null;
  price_idr: number | string;
  stock_quantity: number;
  created_at: string;
  mec_categories: { name: string } | null;
  mec_product_images: Array<{
    storage_path: string;
    alt_text: string | null;
    display_order: number;
  }> | null;
};

export type MecCategory = Pick<Category, 'id' | 'name' | 'description'> & { slug: string };

export async function fetchMecProducts(): Promise<{ products: Product[]; error: Error | null }> {
  const { data, error } = await supabase
    .from('mec_products')
    .select('id, category_id, name, slug, description, price_idr, stock_quantity, created_at, mec_categories(name), mec_product_images(storage_path, alt_text, display_order)')
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  if (error) return { products: [], error };

  const rows = (data ?? []) as unknown as MecProductRow[];
  const products = rows.map((row) => {
    const primaryImage = [...(row.mec_product_images ?? [])]
      .sort((a, b) => a.display_order - b.display_order)[0];
    const imageUrl = primaryImage
      ? getMecProductImageUrl(primaryImage.storage_path)
      : PRODUCT_PLACEHOLDER;

    return {
      id: row.id,
      name: row.name,
      description: row.description ?? '',
      price: Number(row.price_idr),
      image_url: imageUrl,
      category: row.mec_categories?.name ?? 'Uncategorized',
      stock: Number(row.stock_quantity),
      created_at: row.created_at,
      category_id: row.category_id ?? undefined,
    } satisfies Product;
  });

  return { products, error: null };
}

export async function fetchMecCategories(): Promise<{ categories: MecCategory[]; error: Error | null }> {
  const { data, error } = await supabase
    .from('mec_categories')
    .select('id, name, slug, description')
    .eq('is_active', true)
    .order('name', { ascending: true });

  if (error) return { categories: [], error };

  return {
    categories: (data ?? []) as MecCategory[],
    error: null,
  };
}
