-- 017: insider_transaction + acquired_disposed (decisiones-modelo-ownership.md 8, P18, 2026-10-13).
-- Sentido de la operación tal cual lo da el proveedor (transactionAcquiredDisposed del Form 4: 'A' adquirida, 'D' enajenada).
-- Texto nullable y SIN CHECK: es vocabulario de la SEC, no del modelo, y una etiqueta nueva no puede tumbar la ingesta. El sentido
-- no se deduce de transaction_code (M, F o G pueden ir en cualquiera de los dos). shares_transacted sigue sin signo.
ALTER TABLE insider_transaction ADD COLUMN acquired_disposed text;
