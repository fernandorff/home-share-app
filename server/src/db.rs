//! Prepared-statement cache per pooled connection (what Prisma and pgx do): one round trip per query
//! instead of prepare + execute. The pilot measured +33% capacity with it (spec 012).

use tokio_postgres::{types::ToSql, Error, Row};

pub trait Cached {
    async fn cq(&self, sql: &str, params: &[&(dyn ToSql + Sync)]) -> Result<Vec<Row>, Error>;
}

impl Cached for deadpool_postgres::Client {
    async fn cq(&self, sql: &str, params: &[&(dyn ToSql + Sync)]) -> Result<Vec<Row>, Error> {
        let statement = self.prepare_cached(sql).await?;
        self.query(&statement, params).await
    }
}
