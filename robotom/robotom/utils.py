"""Общие утилиты проекта robotom."""


def force_https(url: str) -> str:
    """Заменяет схему http на https в URL.

    Костыль до тех пор, пока request.build_absolute_uri() не возвращает
    корректный протокол за обратным прокси.
    """
    if url.startswith('https'):
        return url
    return url.replace('http', 'https', 1)
