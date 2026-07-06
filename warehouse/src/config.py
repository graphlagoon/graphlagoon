from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    spark_master: str = "local[*]"
    dev_mode: bool = True
    data_path: str = "./data/parquet"
    warehouse_path: str = "./data/warehouse"
    default_catalog: str = "spark_catalog"
    port: int = 8001
    max_recursion_depth: int = 100

    # Opt-in async, cancellable INLINE execution (dev-only). When False
    # (default) INLINE statements run synchronously — the historical behaviour
    # that holds no per-statement server state, so there is no growing
    # `_statements` map or threadpool pressure with large/frequent results.
    # Enable it ONLY to exercise the Query Console's Cancel button locally;
    # the cancel it provides is a simulation, not a real Spark job kill.
    async_inline_execution: bool = True

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


@lru_cache()
def get_settings() -> Settings:
    return Settings()
