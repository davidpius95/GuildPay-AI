/** Injection token for the shared pg Pool. Kept in a leaf file so repositories
 *  and the module can both import it without a circular dependency. */
export const PG_POOL = Symbol('PG_POOL');
