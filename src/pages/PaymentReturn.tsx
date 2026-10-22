import { Link, useSearchParams } from 'react-router-dom';
import { AlertCircle, ArrowLeft, Clock, ShieldCheck } from 'lucide-react';

export default function PaymentReturn() {
  const [searchParams] = useSearchParams();
  const merchantOrderId =
    searchParams.get('merchantOrderId') ??
    searchParams.get('merchant_order_id');

  return (
    <section className="mx-auto max-w-2xl px-4 py-12">
      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800 sm:p-8">
        <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
          <Clock className="h-6 w-6" aria-hidden="true" />
        </div>

        <h1 className="mb-3 text-2xl font-bold text-gray-900 dark:text-white">
          Payment status is being confirmed
        </h1>
        <p className="mb-6 text-gray-600 dark:text-gray-300">
          You have returned from the payment provider. This redirect alone does
          not prove that a payment succeeded. Please wait for the server to
          confirm the payment.
        </p>

        {merchantOrderId && (
          <div className="mb-6 rounded-lg bg-gray-50 p-4 dark:bg-gray-700/60">
            <p className="text-sm text-gray-500 dark:text-gray-300">
              Payment reference
            </p>
            <p className="mt-1 break-all font-mono text-sm text-gray-900 dark:text-white">
              {merchantOrderId}
            </p>
          </div>
        )}

        <div className="mb-6 flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-100">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <p>
            This page does not yet fetch the payment status from the MEC
            backend. Do not use URL parameters as proof of payment, and do not
            create another payment attempt while the result is unresolved.
            Check with support before retrying.
          </p>
        </div>

        <div className="mb-6 flex items-start gap-3 text-sm text-gray-600 dark:text-gray-300">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          <p>
            The authoritative result must come from the server after it
            validates and processes the Duitku callback.
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row">
          <Link
            to="/"
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-5 py-3 font-medium text-white transition-colors hover:opacity-90"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back to home
          </Link>
          <Link
            to="/contact"
            className="inline-flex items-center justify-center rounded-lg border border-gray-300 px-5 py-3 font-medium text-gray-800 transition-colors hover:bg-gray-50 dark:border-gray-600 dark:text-white dark:hover:bg-gray-700"
          >
            Contact support
          </Link>
        </div>
      </div>
    </section>
  );
}
