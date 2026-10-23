import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Clock, Package, RefreshCw } from 'lucide-react';
import AuthGuard from '../components/AuthGuard';
import { supabase } from '../lib/supabase';
import { useAuthStore } from '../store/authStore';

type MECOrder = {
  id: string;
  order_number: string;
  total_amount: number;
  currency: string;
  order_status: string;
  created_at: string;
  items: Array<{
    id: string;
    product_name_snapshot: string;
    quantity: number;
    unit_price_idr: number;
  }>;
  payment: {
    merchant_order_id: string;
    payment_status: string;
    provider_reference: string | null;
    updated_at: string;
  } | null;
};

const formatIDR = (amount: number) => new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  maximumFractionDigits: 0,
}).format(amount);

const formatDate = (value: string) => new Intl.DateTimeFormat('id-ID', {
  dateStyle: 'medium',
  timeStyle: 'short',
}).format(new Date(value));

function MECOrdersContent() {
  const user = useAuthStore((state) => state.user);
  const [orders, setOrders] = useState<MECOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const loadOrders = useCallback(async () => {
    if (!user?.id) {
      setOrders([]);
      setLoading(false);
      return;
    }

    setError('');
    const { data: orderRows, error: orderError } = await supabase
      .from('mec_orders')
      .select('id,order_number,total_amount,currency,order_status,created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (orderError) {
      setError('Unable to load your MEC orders. Please try again.');
      setLoading(false);
      setRefreshing(false);
      return;
    }

    const orderIds = (orderRows ?? []).map((order) => order.id);
    if (orderIds.length === 0) {
      setOrders([]);
      setLoading(false);
      setRefreshing(false);
      return;
    }

    const [itemsResult, paymentsResult] = await Promise.all([
      supabase
        .from('mec_order_items')
        .select('id,order_id,product_name_snapshot,quantity,unit_price_idr')
        .in('order_id', orderIds),
      supabase
        .from('mec_payments')
        .select('order_id,merchant_order_id,payment_status,provider_reference,updated_at')
        .in('order_id', orderIds),
    ]);

    if (itemsResult.error || paymentsResult.error) {
      setError('Your orders were found, but payment or item details could not be loaded.');
      setLoading(false);
      setRefreshing(false);
      return;
    }

    setOrders((orderRows ?? []).map((order) => ({
      ...order,
      items: (itemsResult.data ?? [])
        .filter((item) => item.order_id === order.id)
        .map((item) => ({
          id: item.id,
          product_name_snapshot: item.product_name_snapshot,
          quantity: item.quantity,
          unit_price_idr: item.unit_price_idr,
        })),
      payment: (paymentsResult.data ?? [])
        .filter((payment) => payment.order_id === order.id)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map((payment) => ({
          merchant_order_id: payment.merchant_order_id,
          payment_status: payment.payment_status,
          provider_reference: payment.provider_reference,
          updated_at: payment.updated_at,
        }))[0] ?? null,
    })));

    setLoading(false);
    setRefreshing(false);
  }, [user?.id]);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  const refresh = async () => {
    setRefreshing(true);
    await loadOrders();
  };

  return (
    <section className="container py-10">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">My Orders</h1>
          <p className="mt-2 text-gray-600 dark:text-gray-300">
            Order and payment status from the MEC checkout system.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading || refreshing}
          className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div role="alert" className="mb-6 flex items-start gap-3 rounded-lg border border-red-300 bg-red-50 p-4 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
          <p>{error}</p>
        </div>
      )}

      {loading ? (
        <div className="rounded-lg border border-gray-200 p-8 text-center text-gray-600 dark:border-gray-700 dark:text-gray-300">
          Loading your orders…
        </div>
      ) : orders.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center dark:border-gray-700 dark:bg-gray-800">
          <Package className="mx-auto mb-4 h-12 w-12 text-gray-400" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">No MEC orders yet</h2>
          <p className="mt-2 text-gray-600 dark:text-gray-300">
            Completed checkouts will appear here once an order has been created.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {orders.map((order) => (
            <article key={order.id} className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{order.order_number}</h2>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{formatDate(order.created_at)}</p>
                </div>
                <div className="text-right">
                  <p className="font-semibold text-gray-900 dark:text-white">{formatIDR(Number(order.total_amount))}</p>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{order.currency}</p>
                </div>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-md bg-gray-50 p-3 dark:bg-gray-900">
                  <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Order status</p>
                  <p className="mt-1 font-medium capitalize text-gray-900 dark:text-white">{order.order_status.replaceAll('_', ' ')}</p>
                </div>
                <div className="rounded-md bg-gray-50 p-3 dark:bg-gray-900">
                  <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Payment status</p>
                  <p className="mt-1 flex items-center gap-2 font-medium capitalize text-gray-900 dark:text-white">
                    <Clock className="h-4 w-4" />
                    {order.payment?.payment_status ?? 'not created'}
                  </p>
                  {order.payment?.provider_reference && (
                    <p className="mt-1 break-all text-xs text-gray-500 dark:text-gray-400">
                      Provider reference: {order.payment.provider_reference}
                    </p>
                  )}
                </div>
              </div>

              <ul className="mt-4 divide-y divide-gray-100 dark:divide-gray-700">
                {order.items.map((item) => (
                  <li key={item.id} className="flex items-start justify-between gap-4 py-3 text-sm">
                    <span className="text-gray-700 dark:text-gray-200">
                      {item.product_name_snapshot} × {item.quantity}
                    </span>
                    <span className="shrink-0 text-gray-900 dark:text-white">
                      {formatIDR(Number(item.unit_price_idr) * item.quantity)}
                    </span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export default function MECOrders() {
  return (
    <AuthGuard>
      <MECOrdersContent />
    </AuthGuard>
  );
}
