import numpy as np
import pytest

from core.color_engine import apply_transform, fit_transform, match_colors, rgb_to_lab


def _photo(seed: int, tint: tuple[float, float, float], size: tuple[int, int] = (120, 160)) -> np.ndarray:
    rng = np.random.default_rng(seed)
    base = rng.uniform(60, 200, size=(*size, 1))
    noise = rng.normal(0, 12, size=(*size, 3))
    return np.clip(base * np.asarray(tint) + noise, 0, 255).astype(np.uint8)


@pytest.fixture
def reference() -> np.ndarray:
    return _photo(1, (1.0, 0.85, 0.75))


@pytest.fixture
def target() -> np.ndarray:
    return _photo(2, (0.7, 0.8, 1.05))


def _lab_moments(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    lab = rgb_to_lab(rgb).reshape(-1, 3)
    return lab.mean(axis=0), lab.std(axis=0)


@pytest.mark.parametrize("method", ["reinhard", "histogram"])
def test_full_strength_moves_target_statistics_to_reference(reference, target, method):
    result = match_colors(reference, target, method=method, strength=1.0, exclude_extremes=False)

    ref_mean, ref_std = _lab_moments(reference)
    tar_mean, _ = _lab_moments(target)
    out_mean, out_std = _lab_moments(result)

    assert np.all(np.abs(out_mean - ref_mean) < np.abs(tar_mean - ref_mean))
    np.testing.assert_allclose(out_mean, ref_mean, atol=2.0)
    np.testing.assert_allclose(out_std, ref_std, rtol=0.15, atol=1.0)


def test_zero_strength_returns_original(reference, target):
    transform = fit_transform(reference, target)
    np.testing.assert_array_equal(apply_transform(target, transform, 0.0), target)


def test_partial_strength_lies_between_original_and_full(reference, target):
    transform = fit_transform(reference, target)
    full = apply_transform(target, transform, 1.0).astype(int)
    half = apply_transform(target, transform, 0.5).astype(int)
    expected = (full + target.astype(int)) / 2
    assert np.abs(half - expected).max() <= 1


def test_output_preserves_shape_and_dtype(reference):
    tall_target = _photo(3, (0.9, 0.9, 0.9), size=(700, 90))
    result = match_colors(reference, tall_target)
    assert result.shape == tall_target.shape
    assert result.dtype == np.uint8


def test_flat_target_does_not_divide_by_zero(reference):
    flat = np.full((40, 40, 3), 128, dtype=np.uint8)
    result = match_colors(reference, flat, exclude_extremes=False)
    assert np.isfinite(result).all()


def test_transform_is_hashable(reference, target):
    assert hash(fit_transform(reference, target)) == hash(fit_transform(reference, target))


def test_excluding_extremes_ignores_black_background(reference, target):
    framed = target.copy()
    framed[:, : target.shape[1] // 3] = 0
    with_bg = fit_transform(reference, framed, exclude_extremes=False)
    without_bg = fit_transform(reference, framed, exclude_extremes=True)
    clean = fit_transform(reference, target, exclude_extremes=True)
    assert abs(without_bg.tar_mean[0] - clean.tar_mean[0]) < abs(with_bg.tar_mean[0] - clean.tar_mean[0])
