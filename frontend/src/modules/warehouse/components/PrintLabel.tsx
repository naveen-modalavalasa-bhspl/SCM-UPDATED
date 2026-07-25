// @ts-nocheck
import React, { useRef } from 'react';
import { Button } from 'antd';
import { PrinterOutlined } from '@ant-design/icons';
import { useReactToPrint } from 'react-to-print';
import BarcodeDisplay from './BarcodeDisplay';

const PrintLabel = ({
  value,
  type = 'CODE128',
  title,
  subtitle,
  copies = 1,
  labelWidth = '50mm',
  labelHeight = '30mm',
  showPrintButton = true,
  children,
}) => {
  const printRef = useRef(null);

  const handlePrint = useReactToPrint({
    content: () => printRef.current,
    documentTitle: `Label_${value || 'blank'}`,
  });

  if (!value) {
    return null;
  }

  const renderLabel = () => (
    <div
      className="print-label-container"
      style={{
        width: labelWidth,
        minHeight: labelHeight,
        pageBreakAfter: 'always',
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '8px',
        background: '#ffffff'
      }}
    >
      <BarcodeDisplay
        value={value}
        type={type}
        label={title}
        subtitle={subtitle}
        height={40}
        qrSize={80}
      />
      {children}
    </div>
  );

  const labels = Array.from({ length: copies }, (_, i) => (
    <React.Fragment key={i}>{renderLabel()}</React.Fragment>
  ));

  return (
    <div>
      {showPrintButton && (
        <div className="no-print" style={{ marginBottom: 12 }}>
          <Button
            type="primary"
            icon={<PrinterOutlined />}
            onClick={handlePrint}
          >
            Print Label{copies > 1 ? `s (${copies})` : ''}
          </Button>
        </div>
      )}
      <div ref={printRef}>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            justifyContent: 'center',
          }}
        >
          {labels}
        </div>
      </div>
    </div>
  );
};

export default PrintLabel;
