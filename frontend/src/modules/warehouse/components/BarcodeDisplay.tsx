// @ts-nocheck
import React, { useState, useRef, useEffect } from 'react';
import Barcode from 'react-barcode';
import { QRCodeSVG } from 'qrcode.react';
import { Radio, Button } from 'antd';
import { DownloadOutlined, QrcodeOutlined, BarcodeOutlined } from '@ant-design/icons';

const BarcodeDisplay = ({
  value,
  type = 'CODE128',
  width = 2,
  height = 80,
  displayValue = true,
  label,
  subtitle,
  qrSize = 128,
}) => {
  const containerRef = useRef(null);
  
  // Case-insensitive initial type detection
  const upperType = (type || 'CODE128').toUpperCase();
  const initialIsQR = upperType === 'QR' || upperType === 'QRCODE';
  
  // Local state to allow switching between Barcode and QR Code
  const [codeMode, setCodeMode] = useState(initialIsQR ? 'QR' : 'BARCODE');

  // Keep state in sync with prop changes
  useEffect(() => {
    setCodeMode(initialIsQR ? 'QR' : 'BARCODE');
  }, [type, value]);

  if (!value) {
    return (
      <div className="barcode-display" style={{ textAlign: 'center', padding: '8px' }}>
        <span style={{ color: '#bfbfbf' }}>No barcode value</span>
      </div>
    );
  }

  const handleDownload = () => {
    if (!containerRef.current) return;
    
    // Find the svg inside our container
    const svg = containerRef.current.querySelector('svg');
    if (!svg) return;

    try {
      const svgString = new XMLSerializer().serializeToString(svg);
      const parser = new DOMParser();
      const doc = parser.parseFromString(svgString, 'image/svg+xml');
      const svgElement = doc.documentElement;
      
      let widthAttr = svgElement.getAttribute('width');
      let heightAttr = svgElement.getAttribute('height');
      if (!widthAttr || !heightAttr) {
        const viewBox = svgElement.getAttribute('viewBox');
        if (viewBox) {
          const parts = viewBox.split(' ');
          widthAttr = parts[2];
          heightAttr = parts[3];
        }
      }
      
      const svgW = parseFloat(widthAttr || '200');
      const svgH = parseFloat(heightAttr || '100');
      
      svgElement.setAttribute('width', svgW.toString());
      svgElement.setAttribute('height', svgH.toString());
      
      const serialized = new XMLSerializer().serializeToString(svgElement);
      const svgBlob = new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' });
      const URL = window.URL || window.webkitURL || window;
      const blobURL = URL.createObjectURL(svgBlob);
      
      const img = new Image();
      img.onload = () => {
        // Target dimensions for Zebra printer (50mm x 30mm at 300 DPI): 590 x 354
        const targetW = 590;
        const targetH = 354;
        
        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        
        // Disable image smoothing for high-quality, crisp barcodes and QR codes
        ctx.imageSmoothingEnabled = false;
        ctx.mozImageSmoothingEnabled = false;
        ctx.webkitImageSmoothingEnabled = false;
        ctx.msImageSmoothingEnabled = false;
        
        // Fill white background
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, targetW, targetH);
        
        // Draw subtitle (Item Code / Asset Code) at the top
        ctx.fillStyle = '#000000';
        ctx.textAlign = 'center';
        if (subtitle) {
          ctx.font = 'bold 24px Arial, Helvetica, sans-serif';
          ctx.fillText(subtitle, targetW / 2, 45);
        } else if (!label && codeMode === 'BARCODE') {
          ctx.font = 'bold 24px Arial, Helvetica, sans-serif';
          ctx.fillText(value, targetW / 2, 45);
        }
        
        // Calculate barcode/QR drawing size and positions
        let drawW, drawH, drawX, drawY;
        if (codeMode === 'QR') {
          drawW = 180;
          drawH = 180;
          drawX = (targetW - drawW) / 2;
          drawY = subtitle ? 70 : 87;
        } else {
          // Barcode scaling to center inside label area
          const maxBarcodeW = 510;
          const maxBarcodeH = 180;
          const scale = Math.min(maxBarcodeW / svgW, maxBarcodeH / svgH);
          drawW = svgW * scale;
          drawH = svgH * scale;
          drawX = (targetW - drawW) / 2;
          drawY = subtitle ? 80 : 87;
        }
        
        ctx.drawImage(img, drawX, drawY, drawW, drawH);
        
        // Draw label (Item Name) at the bottom
        if (label) {
          ctx.font = 'bold 20px Arial, Helvetica, sans-serif';
          ctx.fillText(label, targetW / 2, 320);
        }
        
        const png = canvas.toDataURL('image/png');
        const downloadLink = document.createElement('a');
        downloadLink.href = png;
        downloadLink.download = `${value}_${codeMode.toLowerCase()}.png`;
        document.body.appendChild(downloadLink);
        downloadLink.click();
        document.body.removeChild(downloadLink);
        URL.revokeObjectURL(blobURL);
      };
      img.src = blobURL;
    } catch (err) {
      console.error('Failed to download barcode/QR image:', err);
    }
  };

  return (
    <div 
      className="barcode-display-wrapper" 
      style={{ 
        display: 'inline-flex', 
        flexDirection: 'column', 
        alignItems: 'center', 
        background: '#ffffff', 
        padding: '12px', 
        borderRadius: '8px', 
        border: '1px solid #f0f0f0',
        boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
        width: '100%',
        maxWidth: '300px'
      }}
    >
      {/* Inject styling to make barcodes and QR codes render with pixel-perfect crispness */}
      <style>{`
        .barcode-display-wrapper img, 
        .barcode-display-wrapper canvas, 
        .barcode-display-wrapper svg {
          image-rendering: -moz-crisp-edges !important;
          image-rendering: -webkit-crisp-edges !important;
          image-rendering: pixelated !important;
          image-rendering: crisp-edges !important;
        }
      `}</style>

      {/* Dynamic Switch & Download controls */}
      <div 
        className="no-print" 
        style={{ 
          marginBottom: '10px', 
          width: '100%', 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center', 
          gap: '8px' 
        }}
      >
        <Radio.Group 
          size="small" 
          value={codeMode} 
          onChange={(e) => setCodeMode(e.target.value)}
          buttonStyle="solid"
        >
          <Radio.Button value="BARCODE" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <BarcodeOutlined /> Barcode
          </Radio.Button>
          <Radio.Button value="QR" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <QrcodeOutlined /> QR
          </Radio.Button>
        </Radio.Group>
        <Button 
          type="text" 
          size="small" 
          icon={<DownloadOutlined />} 
          onClick={handleDownload}
          title="Download Code"
        />
      </div>

      {/* Code Render Area */}
      <div ref={containerRef} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', width: '100%' }}>
        {subtitle && <div className="barcode-display-label" style={{ fontWeight: 600, fontSize: '13px', color: '#1A1A1A', marginBottom: '6px', textAlign: 'center', width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subtitle}</div>}
        
        {codeMode === 'QR' ? (
          <div style={{ padding: '6px', background: '#ffffff', borderRadius: '4px', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
            <QRCodeSVG
              value={value}
              size={qrSize}
              level="M"
              includeMargin={false}
            />
          </div>
        ) : (
          <div style={{ overflowX: 'auto', maxWidth: '100%', display: 'flex', justifyContent: 'center' }}>
            <Barcode
              value={value}
              format={upperType === 'QR' || upperType === 'QRCODE' ? 'CODE128' : upperType}
              width={width}
              height={height}
              displayValue={displayValue}
              fontSize={13}
              margin={4}
              background="#ffffff"
              lineColor="#000000"
            />
          </div>
        )}

        {label && <div className="barcode-display-label" style={{ fontSize: '11px', color: '#6C757D', marginTop: '6px', textAlign: 'center', width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>}
      </div>
    </div>
  );
};

export default BarcodeDisplay;
