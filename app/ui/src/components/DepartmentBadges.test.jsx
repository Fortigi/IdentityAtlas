// @vitest-environment jsdom
// Tests for the shared Avatar / TierBadge primitives.
//
// Avatar is the single place a person's face or initial is drawn, so the cases
// below pin the decision it makes — photo or initial — and the fallbacks that
// keep a missing or broken image from leaving a hole in a list.

import { describe, it, expect, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Avatar, TierBadge } from './DepartmentBadges';
import { TIER_STYLES } from '@ui/utils/tierStyles';

// This config does not enable vitest globals, so RTL's automatic per-test
// cleanup is not registered. Without this, every render stays in the document
// and a getByText() matches the leftovers from earlier tests.
afterEach(cleanup);

const PHOTO = 'data:image/jpeg;base64,AQID';

describe('Avatar', () => {
  it('renders the photo when one is supplied', () => {
    const { container } = render(<Avatar name="Ada Lovelace" photo={PHOTO} />);
    expect(container.querySelector('img')).toHaveAttribute('src', PHOTO);
    // The initial must NOT also be rendered — a photo sitting on top of a
    // coloured letter shows a rim of the wrong colour around the face.
    expect(screen.queryByText('A')).toBeNull();
  });

  it('renders the initial when there is no photo', () => {
    render(<Avatar name="Ada Lovelace" />);
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('uppercases a lowercase initial', () => {
    render(<Avatar name="ada" />);
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('falls back to ? for a missing or empty name', () => {
    const { rerender } = render(<Avatar />);
    expect(screen.getByText('?')).toBeInTheDocument();
    rerender(<Avatar name="" />);
    expect(screen.getByText('?')).toBeInTheDocument();
  });

  it('falls back to the initial when the photo fails to load', () => {
    // A stored blob that is not a decodable image would otherwise leave the
    // browser's broken-image glyph in every row it appears in.
    const { container } = render(<Avatar name="Ada" photo="data:image/jpeg;base64,bm90YW5pbWFnZQ==" />);
    fireEvent.error(container.querySelector('img'));
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('retries the image when the photo changes after a failure', () => {
    // A list re-renders the same Avatar slot for a different person. Without
    // resetting the failure flag, one person's broken image would suppress the
    // photo of everyone shown in that slot afterwards.
    const { container, rerender } = render(<Avatar name="Ada" photo="data:image/jpeg;base64,YmFk" />);
    fireEvent.error(container.querySelector('img'));
    expect(screen.getByText('A')).toBeInTheDocument();

    rerender(<Avatar name="Grace" photo={PHOTO} />);
    expect(container.querySelector('img')).toHaveAttribute('src', PHOTO);
  });

  it('tints the initial by risk tier', () => {
    const { container } = render(<Avatar name="Ada" tier="Critical" />);
    expect(container.firstChild).toHaveStyle({ backgroundColor: TIER_STYLES.Critical.avatar });
  });

  it('applies the requested size to both the photo and the initial', () => {
    // The two branches are separate elements; a size prop wired to only one of
    // them changes the layout when a person happens to have no photo.
    const { container, rerender } = render(<Avatar name="Ada" size="w-10 h-10" photo={PHOTO} />);
    expect(container.firstChild).toHaveClass('w-10', 'h-10');

    rerender(<Avatar name="Ada" size="w-10 h-10" />);
    expect(container.firstChild).toHaveClass('w-10', 'h-10');
  });

  it('leaves the image out of the accessible name', () => {
    // The person's name is always rendered as text next to the avatar, so an
    // alt text here would make screen readers announce it twice.
    const { container } = render(<Avatar name="Ada Lovelace" photo={PHOTO} />);
    expect(container.querySelector('img')).toHaveAttribute('alt', '');
  });
});

describe('TierBadge', () => {
  it('renders a meaningful tier', () => {
    render(<TierBadge tier="High" />);
    expect(screen.getByText('High')).toBeInTheDocument();
  });

  it('hides None and Minimal unless showAll is set', () => {
    const { rerender } = render(<TierBadge tier="Minimal" />);
    expect(screen.queryByText('Minimal')).toBeNull();
    rerender(<TierBadge tier="Minimal" showAll />);
    expect(screen.getByText('Minimal')).toBeInTheDocument();
  });
});
