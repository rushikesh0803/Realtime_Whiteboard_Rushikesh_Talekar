import React from 'react';

export default function Loader() {
  return (
    <div className="min-h-screen w-full grid place-items-center bg-white">
      <img src="/loader.gif" alt="Loading..." className="w-[300px] h-auto" />
    </div>
  );
}
