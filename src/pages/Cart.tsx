import { useEffect, useMemo, useState } from 'react';
import { ShoppingCart, Trash2, ArrowLeft, Plus, Minus, AlertCircle } from 'lucide-react';
import { useCartStore } from '../store/cartStore';
import { supabase } from '../lib/supabase';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';

const formatIDR = (amount: number) => new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  maximumFractionDigits: 0,
}).format(amount);

export default function Cart() {
  const cartItems = useCartStore((state) => state.items);
  const removeItem = useCartStore((state) => state.removeItem);
  const updateQuantity = useCartStore((state) => state.updateQuantity);
  const clearCart = useCartStore((state) => state.clearCart);
  const [loading, setLoading] = useState(false);
  const [checkoutError, setCheckoutError] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const navigate = useNavigate();
  const { user, profile } = useAuthStore();

  const cartFingerprint = useMemo(
    () => cartItems
      .map((item) => `${item.id}:${item.quantity}`)
      .sort()
      .join('|'),
    [cartItems],
  );

  useEffect(() => {
    if (profile?.full_name) setCustomerName((current) => current.trim() ? current : profile.full_name ?? '');
    if (profile?.phone) setCustomerPhone((current) => current.trim() ? current : profile.phone ?? '');
    if (user?.email) setCustomerEmail((current) => current.trim() ? current : user.email ?? '');
  }, [profile?.full_name, profile?.phone, user?.email]);

  const handleQuantityChange = (productId: string, newQuantity: number) => {
    if (newQuantity <= 0) {
      removeItem(productId);
    } else {
      updateQuantity(productId, newQuantity);
    }
    setCheckoutError('');
  };

  const checkout = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading || cartItems.length === 0) return;

    if (!user) {
      navigate('/auth', { state: { from: '/cart', message: 'Please sign in to complete your purchase' } });
      return;
    }

    const name = customerName.trim();
    const email = customerEmail.trim();
    const phone = customerPhone.trim();
    if (!name || !email || !phone) {
      setCheckoutError('Enter your full name, email address, and phone number to continue.');
      return;
    }

    setLoading(true);
    setCheckoutError('');
    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (sessionError || !accessToken) {
        navigate('/auth', { state: { from: '/cart', message: 'Your session has expired. Please sign in again.' } });
        return;
      }

      // Reuse the same order key on retries so a network timeout cannot reserve stock twice.
      const orderKeyStorage = `mec-checkout-idem:${user.id}:${cartFingerprint}`;
      let checkoutIdempotencyKey = sessionStorage.getItem(orderKeyStorage);
      if (!checkoutIdempotencyKey) {
        checkoutIdempotencyKey = crypto.randomUUID();
        sessionStorage.setItem(orderKeyStorage, checkoutIdempotencyKey);
      }

      const { data: orderResult, error: orderError } = await supabase.functions.invoke('mec-create-order', {
        body: {
          customer_name: name,
          customer_email: email,
          customer_phone: phone,
          idempotency_key: checkoutIdempotencyKey,
          // Client-supplied price/total is intentionally omitted. The database prices products.
          items: cartItems.map((item) => ({ product_id: item.id, quantity: item.quantity })),
        },
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (orderError) {
        throw new Error(orderResult?.error || orderError.message || 'Unable to create your order.');
      }
      const orderId = orderResult?.order?.id;
      if (typeof orderId !== 'string' || !orderId) {
        throw new Error(orderResult?.error || 'The checkout service returned an invalid order.');
      }

      // Keep a stable payment key for retries of this order; unknown outcomes must be reconciled.
      const paymentKeyStorage = `mec-payment-idem:${orderId}`;
      let paymentIdempotencyKey = sessionStorage.getItem(paymentKeyStorage);
      if (!paymentIdempotencyKey) {
        paymentIdempotencyKey = crypto.randomUUID();
        sessionStorage.setItem(paymentKeyStorage, paymentIdempotencyKey);
      }

      const { data: paymentResult, error: paymentError } = await supabase.functions.invoke('mec-duitku-create-invoice', {
        body: {
          order_id: orderId,
          idempotency_key: paymentIdempotencyKey,
          expiry_period: 60,
        },
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (paymentError) {
        throw new Error(
          paymentResult?.error ||
          paymentError.message ||
          'Unable to create a payment invoice. Do not retry with a new payment attempt until the outcome is reconciled.',
        );
      }

      const paymentUrl = paymentResult?.payment?.payment_url;
      if (typeof paymentUrl !== 'string' || !paymentUrl.startsWith('https://')) {
        throw new Error(paymentResult?.error || 'No valid Duitku payment URL was returned. Reconcile the payment before retrying.');
      }

      sessionStorage.removeItem(orderKeyStorage);
      clearCart();
      window.location.assign(paymentUrl);
    } catch (error) {
      setCheckoutError(error instanceof Error ? error.message : 'Checkout failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const itemCount = cartItems.reduce((sum, item) => sum + item.quantity, 0);
  const displayTotal = cartItems.reduce((sum, item) => sum + item.price * item.quantity, 0);

  return (
    <section className="container py-10">
      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-6">
        Your Cart
      </h1>
      {cartItems.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 p-8 rounded-lg shadow-md text-center">
          <ShoppingCart className="h-16 w-16 mx-auto text-gray-400 mb-4" />
          <p className="text-gray-600 dark:text-gray-300 text-lg mb-6">Your cart is empty.</p>
          <Link
            to="/products"
            className="inline-block px-6 py-2 bg-primary text-white rounded-md hover:bg-magenta-600 transition-colors btn-hover-scale btn-hover-shadow"
          >
            Continue shopping
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="md:col-span-2 space-y-4">
            {cartItems.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between bg-white dark:bg-gray-800 p-4 rounded-lg shadow-sm border-l-4 border-primary"
              >
                <div className="flex items-center min-w-0">
                  <img
                    src={item.image}
                    alt={item.name}
                    className="w-16 h-16 object-cover rounded-md mr-4"
                  />
                  <div className="min-w-0">
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                      {item.name}
                    </h2>
                    <p className="text-gray-600 dark:text-gray-300">
                      ${formatIDR(item.price)} <span className="text-xs">(display estimate)</span>
                    </p>
                    <div className="flex items-center mt-2">
                      <button
                        type="button"
                        aria-label={`Decrease quantity of ${item.name}`}
                        onClick={() => handleQuantityChange(item.id, item.quantity - 1)}
                        className="p-1 bg-gray-100 dark:bg-gray-700 rounded-l-md hover:bg-gray-200 dark:hover:bg-gray-600"
                      >
                        <Minus className="h-4 w-4 text-gray-600 dark:text-gray-300" />
                      </button>
                      <span className="px-3 py-1 bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200">
                        {item.quantity}
                      </span>
                      <button
                        type="button"
                        aria-label={`Increase quantity of ${item.name}`}
                        onClick={() => handleQuantityChange(item.id, item.quantity + 1)}
                        className="p-1 bg-gray-100 dark:bg-gray-700 rounded-r-md hover:bg-gray-200 dark:hover:bg-gray-600"
                      >
                        <Plus className="h-4 w-4 text-gray-600 dark:text-gray-300" />
                      </button>
                    </div>
                  </div>
                </div>
                <div className="flex flex-col items-end pl-3">
                  <p className="font-semibold text-gray-900 dark:text-white mb-2">
                    {formatIDR(item.price * item.quantity)}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      removeItem(item.id);
                      setCheckoutError('');
                    }}
                    aria-label={`Remove ${item.name} from cart`}
                    className="text-red-500 hover:text-red-600 transition-colors"
                  >
                    <Trash2 className="h-5 w-5" />
                  </button>
                </div>
              </div>
            ))}

            <div className="mt-6">
              <Link
                to="/products"
                className="inline-flex items-center text-primary hover:text-magenta-600 transition-colors link-hover"
              >
                <ArrowLeft className="h-4 w-4 mr-2" />
                Continue Shopping
              </Link>
            </div>
          </div>

          <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-md h-fit">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
              Order Summary
            </h2>
            <div className="space-y-2 mb-4">
              <div className="flex justify-between text-gray-600 dark:text-gray-300">
                <span>Subtotal ({itemCount} items)</span>
                <span>{formatIDR(displayTotal)}</span>
              </div>
              <div className="flex justify-between text-gray-600 dark:text-gray-300">
                <span>Shipping</span>
                <span>Free</span>
              </div>
              <div className="border-t border-gray-200 dark:border-gray-700 pt-2 mt-2">
                <div className="flex justify-between font-semibold text-lg">
                  <span>Estimated total</span>
                  <span className="text-primary">{formatIDR(displayTotal)}</span>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                  Final total is calculated from current database prices during checkout and may differ from this estimate.
                </p>
              </div>
            </div>

            {!user ? (
              <div className="mb-4 rounded-lg bg-gray-50 dark:bg-gray-700 p-3 text-sm text-gray-600 dark:text-gray-200">
                Sign in is required to place an order.
              </div>
            ) : (
              <form onSubmit={checkout} className="space-y-3 mb-4">
                <h3 className="font-semibold text-gray-900 dark:text-white">Checkout details</h3>
                <div>
                  <label htmlFor="checkout-name" className="block text-sm text-gray-700 dark:text-gray-300 mb-1">Full name *</label>
                  <input
                    id="checkout-name"
                    autoComplete="name"
                    value={customerName}
                    onChange={(event) => setCustomerName(event.target.value)}
                    maxLength={160}
                    required
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-gray-900 dark:text-white"
                  />
                </div>
                <div>
                  <label htmlFor="checkout-email" className="block text-sm text-gray-700 dark:text-gray-300 mb-1">Email *</label>
                  <input
                    id="checkout-email"
                    type="email"
                    autoComplete="email"
                    value={customerEmail}
                    onChange={(event) => setCustomerEmail(event.target.value)}
                    maxLength={254}
                    required
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-gray-900 dark:text-white"
                  />
                </div>
                <div>
                  <label htmlFor="checkout-phone" className="block text-sm text-gray-700 dark:text-gray-300 mb-1">Phone number *</label>
                  <input
                    id="checkout-phone"
                    type="tel"
                    autoComplete="tel"
                    value={customerPhone}
                    onChange={(event) => setCustomerPhone(event.target.value)}
                    maxLength={50}
                    required
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-gray-900 dark:text-white"
                  />
                </div>
                {checkoutError && (
                  <div role="alert" className="flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-900/20 dark:text-red-200">
                    <AlertCircle className="h-5 w-5 shrink-0" />
                    <span>{checkoutError}</span>
                  </div>
                )}
                <button
                  type="submit"
                  disabled={loading || cartItems.length === 0}
                  className="w-full flex items-center justify-center bg-primary text-white px-6 py-3 rounded-lg hover:bg-magenta-600 transition-colors disabled:bg-gray-400 btn-hover-scale"
                >
                  <ShoppingCart className="h-5 w-5 mr-2" />
                  {loading ? 'Creating secure payment...' : 'Continue to Duitku payment'}
                </button>
              </form>
            )}

            {!user && (
              <button
                type="button"
                onClick={() => navigate('/auth', { state: { from: '/cart', message: 'Please sign in to complete your purchase' } })}
                className="w-full flex items-center justify-center bg-primary text-white px-6 py-3 rounded-lg hover:bg-magenta-600 transition-colors btn-hover-scale"
              >
                Sign in to checkout
              </button>
            )}
            <Link
              to="/products"
              className="w-full flex items-center justify-center bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-white px-6 py-3 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors text-center btn-hover-shadow mt-3"
            >
              Add more products
            </Link>
          </div>
        </div>
      )}
    </section>
  );
}
