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

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


@lru_cache()
def get_settings() -> Settings:
    return Settings()
