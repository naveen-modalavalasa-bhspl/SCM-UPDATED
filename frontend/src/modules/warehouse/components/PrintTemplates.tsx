// @ts-nocheck
import React from 'react';
import { formatCurrency, formatDate } from '../utils/helpers';

const COMPANY = {
  name: 'Bavya Health Services Pvt. Ltd.',
  address: '0-0, First Floor, Ranipool Bazaar, Ranipool, Upper Tadong, Gangtok, Sikkim, 737135, India',
  phone: '+91 94925 04944',
  email: 'accounts@bhspl.in',
  website: 'www.bhspl.in',
  gstin: '11AADCB5486B1Z5',
  stateCode: '11',
};

const printStyles = `
  @media print {
    body * { visibility: hidden; }
    .print-document, .print-document * { visibility: visible; }
    .print-document { position: absolute; left: 0; top: 0; width: 100%; }
    .no-print { display: none !important; }
  }
  .print-document {
    font-family: 'Segoe UI', Arial, sans-serif;
    color: #222;
    max-width: 800px;
    margin: 0 auto;
    padding: 20px;
    font-size: 12px;
    line-height: 1.4;
  }
  .print-document table {
    width: 100%;
    border-collapse: collapse;
    margin: 10px 0;
  }
  .print-document th, .print-document td {
    border: 1px solid #ccc;
    padding: 6px 10px;
    text-align: left;
    font-size: 12px;
  }
  .print-document th {
    background: #f5f5f5;
    font-weight: 600;
  }
  .doc-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 15px; }
  .doc-title { font-size: 22px; font-weight: 700; text-align: right; }
  .doc-subtitle { font-size: 11px; color: #666; text-align: right; }
  .company-info { font-size: 11px; line-height: 1.5; }
  .company-info strong { font-size: 13px; }
  .section-header {
    background: #E87C1E; color: white; padding: 4px 10px;
    font-weight: 700; font-size: 12px; margin: 12px 0 4px 0;
  }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
  .info-row { display: flex; padding: 4px 10px; border-bottom: 1px solid #eee; }
  .info-label { font-weight: 600; min-width: 140px; color: #555; }
  .info-value { flex: 1; }
  .totals-section { display: flex; justify-content: flex-end; margin-top: 10px; }
  .totals-table { width: 300px; }
  .totals-table td { border: none; padding: 4px 10px; }
  .totals-table td:last-child { text-align: right; font-weight: 600; }
  .totals-table tr:last-child td { border-top: 2px solid #333; font-size: 14px; }
  .signature-section { display: flex; justify-content: space-between; margin-top: 40px; padding-top: 15px; }
  .signature-box { text-align: center; width: 200px; }
  .signature-line { border-top: 1px solid #333; margin-top: 50px; padding-top: 5px; }
  .draft-watermark {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-30deg);
    font-size: 80px; color: rgba(0,0,0,0.06); font-weight: bold; pointer-events: none; z-index: 0;
  }
  .po-orange th { background: #E87C1E; color: white; }
  .po-orange .section-header { background: #E87C1E; }
  .notes-section { margin-top: 12px; padding: 8px 10px; border: 1px solid #eee; min-height: 40px; }
  .notes-label { font-weight: 600; color: #E87C1E; margin-bottom: 4px; }
`;

/* ─────────────────── PURCHASE ORDER ─────────────────── */
export const PurchaseOrderPrint = React.forwardRef(({ data }, ref) => {
  if (!data) return null;
  const items = data.items || [];
  const subtotal = items.reduce((s, i) => s + (parseFloat(i.quantity || 0) * parseFloat(i.unit_price || 0)), 0);
  const taxAmt = items.reduce((s, i) => s + parseFloat(i.tax_amount || 0), 0);
  const total = subtotal + taxAmt;

  return (
    <div ref={ref} className="print-document po-orange" style={{ position: 'relative' }}>
      <style>{printStyles}</style>
      {data.status === 'draft' && <div className="draft-watermark">DRAFT</div>}

      <div className="doc-header">
        <div className="company-info">
          <div>{COMPANY.address.split(',').slice(0, 2).join(', ')}</div>
          <div>{COMPANY.address.split(',').slice(2).join(', ')}</div>
          <div><strong>{COMPANY.email}</strong></div>
          <div>{COMPANY.website}</div>
        </div>
        <div>
          <div className="doc-title" style={{ color: '#E87C1E' }}>PURCHASE ORDER</div>
          <div className="doc-subtitle">Date: <strong>{formatDate(data.po_date || data.created_at)}</strong></div>
          <div className="doc-subtitle">PO No: <strong>{data.po_number}</strong></div>
        </div>
      </div>

      <div className="section-header">VENDOR INFORMATION</div>
      <div className="info-grid">
        <div className="info-row"><span className="info-label">VENDOR NAME</span><span className="info-value">{data.vendor_name || '-'}</span></div>
        <div className="info-row"><span className="info-label">SALES PERSON</span><span className="info-value">{data.sales_person || '-'}</span></div>
        <div className="info-row"><span className="info-label">ADDRESS</span><span className="info-value">{data.vendor_address || '-'}</span></div>
        <div className="info-row"><span className="info-label">EMAIL ADDRESS</span><span className="info-value">{data.vendor_email || '-'}</span></div>
        <div className="info-row"><span className="info-label">CONTACT NO.</span><span className="info-value">{data.vendor_phone || '-'}</span></div>
        <div className="info-row"><span className="info-label">GSTIN</span><span className="info-value">{data.vendor_gstin || '-'}</span></div>
      </div>

      <div className="section-header">CUSTOMER INFORMATION</div>
      <div className="info-grid">
        <div className="info-row"><span className="info-label">CUSTOMER NAME</span><span className="info-value"><strong>{COMPANY.name}</strong></span></div>
        <div className="info-row"><span className="info-label">CONTACT PERSON</span><span className="info-value">{data.contact_person || '-'}</span></div>
        <div className="info-row" style={{ gridColumn: '1 / -1' }}><span className="info-label">ADDRESS</span><span className="info-value"><strong>{COMPANY.address}</strong></span></div>
        <div className="info-row"><span className="info-label">CONTACT NO.</span><span className="info-value">{COMPANY.phone}</span></div>
        <div className="info-row"><span className="info-label">EMAIL ADDRESS</span><span className="info-value">{COMPANY.email}</span></div>
      </div>

      <table style={{ marginTop: 15 }}>
        <thead><tr>
          <th style={{ width: 40 }}>SNo</th>
          <th>Details</th>
          <th style={{ width: 60 }}>Unit</th>
          <th style={{ width: 70, textAlign: 'right' }}>Quantity</th>
          <th style={{ width: 90, textAlign: 'right' }}>Unit Price</th>
          <th style={{ width: 90, textAlign: 'right' }}>Total</th>
        </tr></thead>
        <tbody>
          {items.map((item, i) => (
            <tr key={i}>
              <td>{i + 1}</td>
              <td>{item.item_name || item.name || '-'}</td>
              <td>{item.uom_name || item.uom || '-'}</td>
              <td style={{ textAlign: 'right' }}>{item.quantity || 0}</td>
              <td style={{ textAlign: 'right' }}>{formatCurrency(item.unit_price || 0)}</td>
              <td style={{ textAlign: 'right' }}>{formatCurrency((item.quantity || 0) * (item.unit_price || 0))}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
        <div style={{ flex: 1 }}>
          <div className="notes-label" style={{ color: '#E87C1E' }}>Additional Notes:</div>
          <div className="notes-section">{data.notes || data.remarks || ''}</div>
        </div>
        <div className="totals-table" style={{ marginLeft: 20 }}>
          <table style={{ border: 'none' }}>
            <tbody>
              <tr><td>Subtotal</td><td style={{ textAlign: 'right' }}>{formatCurrency(subtotal)}</td></tr>
              {taxAmt > 0 && <tr><td>Tax</td><td style={{ textAlign: 'right' }}>{formatCurrency(taxAmt)}</td></tr>}
              <tr style={{ borderTop: '2px solid #333' }}><td><strong>Total</strong></td><td style={{ textAlign: 'right', fontSize: 14 }}><strong>{formatCurrency(total)}</strong></td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="signature-section">
        <div className="signature-box"><div className="signature-line">Prepared By</div></div>
        <div className="signature-box"><div className="signature-line">Authorized By</div></div>
      </div>
    </div>
  );
});

/* ─────────────────── REQUEST FOR QUOTATION ─────────────────── */
export const RFQPrint = React.forwardRef(({ data }, ref) => {
  if (!data) return null;
  const items = data.items || [];

  return (
    <div ref={ref} className="print-document" style={{ position: 'relative' }}>
      <style>{printStyles}</style>
      {data.status === 'draft' && <div className="draft-watermark">DRAFT</div>}

      <div style={{ textAlign: 'center', marginBottom: 20 }}>
        <div style={{ fontSize: 24, fontWeight: 700, color: '#555' }}>REQUEST FOR QUOTATION</div>
        <div style={{ fontSize: 12, color: '#999' }}>{data.rfq_number || data.quotation_number || ''}</div>
      </div>

      <div style={{ textAlign: 'center', fontSize: 16, fontWeight: 700, marginBottom: 15 }}>
        {data.status?.toUpperCase() || 'DRAFT'}
      </div>

      <div className="info-grid" style={{ marginBottom: 15 }}>
        <div>
          <div className="info-row"><span className="info-label">Company Billing Address:</span><span className="info-value">{COMPANY.name}-Billing</span></div>
          <div className="info-row"><span className="info-label">Billing Address Details:</span>
            <span className="info-value">
              {COMPANY.address.split(',').map((line, i) => <div key={i}>{line.trim()}</div>)}
              <div>State Code: {COMPANY.stateCode}</div>
              <div>GSTIN: {COMPANY.gstin}</div>
            </span>
          </div>
        </div>
        <div>
          <div className="info-row"><span className="info-label">Date:</span><span className="info-value">{formatDate(data.rfq_date || data.created_at)}</span></div>
          <div className="info-row"><span className="info-label">Valid Till:</span><span className="info-value">{formatDate(data.valid_till || data.deadline)}</span></div>
        </div>
      </div>

      <table>
        <thead><tr>
          <th style={{ width: 50 }}>Sr</th>
          <th>Item</th>
          <th style={{ width: 120 }}>Required Date</th>
          <th style={{ width: 90, textAlign: 'right' }}>Quantity</th>
        </tr></thead>
        <tbody>
          {items.map((item, i) => (
            <tr key={i}>
              <td>{i + 1}</td>
              <td>{item.item_name || item.name || '-'}</td>
              <td>{formatDate(item.required_date || data.deadline)}</td>
              <td style={{ textAlign: 'right' }}>{item.quantity || 0}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 20 }}>
        <div><strong>Subject:</strong> Request for Quotation</div>
        {data.notes && <div style={{ marginTop: 5 }}><strong>Notes:</strong> {data.notes}</div>}
      </div>

      <div className="signature-section">
        <div className="signature-box"><div className="signature-line">Authorized By</div></div>
      </div>
    </div>
  );
});

/* ─────────────────── PURCHASE RECEIPT / GRN ─────────────────── */
export const PurchaseReceiptPrint = React.forwardRef(({ data }, ref) => {
  if (!data) return null;
  const items = data.items || [];
  const total = items.reduce((s, i) => s + (parseFloat(i.accepted_qty || i.quantity || 0) * parseFloat(i.rate || i.unit_price || 0)), 0);
  const totalQty = items.reduce((s, i) => s + parseFloat(i.accepted_qty || i.quantity || 0), 0);
  const grandTotal = total;
  const roundedTotal = Math.round(grandTotal);

  return (
    <div ref={ref} className="print-document" style={{ position: 'relative' }}>
      <style>{printStyles}</style>
      {data.status === 'draft' && <div className="draft-watermark">DRAFT</div>}

      <div style={{ textAlign: 'center', marginBottom: 20 }}>
        <div style={{ fontSize: 24, fontWeight: 700, color: '#555' }}>PURCHASE RECEIPT</div>
        <div style={{ fontSize: 12, color: '#999' }}>{data.grn_number || ''}</div>
      </div>

      <div style={{ textAlign: 'center', fontSize: 16, fontWeight: 700, marginBottom: 10 }}>
        {data.status?.toUpperCase() || 'DRAFT'}
      </div>

      <div style={{ textAlign: 'center', marginBottom: 15 }}>
        <div><strong>Date:</strong></div>
        <div>{formatDate(data.received_date || data.created_at)}</div>
      </div>

      <table>
        <thead><tr>
          <th style={{ width: 50 }}>Sr</th>
          <th>Item</th>
          <th style={{ width: 110, textAlign: 'right' }}>Accepted Quantity</th>
          <th style={{ width: 90, textAlign: 'right' }}>Rate</th>
          <th style={{ width: 90, textAlign: 'right' }}>Amount</th>
        </tr></thead>
        <tbody>
          {items.map((item, i) => {
            const qty = parseFloat(item.accepted_qty || item.quantity || 0);
            const rate = parseFloat(item.rate || item.unit_price || 0);
            return (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>{item.item_name || item.name || '-'}</td>
                <td style={{ textAlign: 'right' }}>{qty}</td>
                <td style={{ textAlign: 'right' }}>{formatCurrency(rate)}</td>
                <td style={{ textAlign: 'right' }}>{formatCurrency(qty * rate)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
        <div><strong>Total Quantity:</strong><br />{totalQty}</div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 20 }}><span><strong>Total</strong></span><span>{formatCurrency(total)}</span></div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 20, marginTop: 4 }}><span><strong>Grand Total:</strong></span><span>{formatCurrency(grandTotal)}</span></div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 20, marginTop: 4 }}><span><strong>Rounded Total:</strong></span><span>{formatCurrency(roundedTotal)}</span></div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 25 }}>
        <div><strong>Company Billing Address:</strong><br />{COMPANY.name}-Billing</div>
        <div style={{ textAlign: 'right' }}>
          <strong>Billing Address:</strong><br />
          {COMPANY.address.split(',').map((l, i) => <div key={i}>{l.trim()}</div>)}
          <div>State Code: {COMPANY.stateCode}</div>
          <div>GSTIN: {COMPANY.gstin}</div>
        </div>
      </div>

      <div className="signature-section">
        <div className="signature-box"><div className="signature-line">Received By</div></div>
        <div className="signature-box"><div className="signature-line">Checked By</div></div>
        <div className="signature-box"><div className="signature-line">Authorized By</div></div>
      </div>
    </div>
  );
});

/* ─────────────────── DELIVERY CHALLAN ─────────────────── */
export const DeliveryChallanPrint = React.forwardRef(({ data }, ref) => {
  if (!data) return null;
  const items = data.items || [];

  return (
    <div ref={ref} className="print-document" style={{ position: 'relative' }}>
      <style>{printStyles}</style>

      <div style={{ textAlign: 'center', borderBottom: '3px solid #1a4b8c', paddingBottom: 15, marginBottom: 15 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#1a4b8c', letterSpacing: 2 }}>DELIVERY CHALLAN</div>
        <div style={{ fontSize: 22, fontWeight: 800, color: '#1a4b8c', margin: '5px 0' }}>BAVYA HEALTH SERVICE PVT. LTD</div>
        <div style={{ fontSize: 10, color: '#555' }}>GST - {COMPANY.gstin}</div>
        <div style={{ fontSize: 10, color: '#555' }}>{COMPANY.address}</div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 15 }}>
        <div><strong>M/s:</strong> {data.customer_name || data.recipient || '-'}</div>
        <div><strong>No:</strong> {data.challan_number || data.dispatch_number || '-'}</div>
      </div>
      <div style={{ marginBottom: 15 }}><strong>Date:</strong> {formatDate(data.challan_date || data.dispatch_date || data.created_at)}</div>

      <table>
        <thead><tr>
          <th style={{ width: 50 }}>Qty</th>
          <th>PRODUCT NAME</th>
          <th style={{ width: 80 }}>HSN Code</th>
          <th style={{ width: 80, textAlign: 'right' }}>UNIT Price</th>
          <th style={{ width: 90, textAlign: 'right' }}>AMOUNT Rs.</th>
        </tr></thead>
        <tbody>
          {items.map((item, i) => (
            <tr key={i}>
              <td>{item.quantity || 0}</td>
              <td>{item.item_name || item.name || '-'}</td>
              <td>{item.hsn_code || '-'}</td>
              <td style={{ textAlign: 'right' }}>{formatCurrency(item.unit_price || item.rate || 0)}</td>
              <td style={{ textAlign: 'right' }}>{formatCurrency((item.quantity || 0) * (item.unit_price || item.rate || 0))}</td>
            </tr>
          ))}
          {items.length < 10 && Array(10 - items.length).fill(null).map((_, i) => (
            <tr key={`empty-${i}`}><td>&nbsp;</td><td></td><td></td><td></td><td></td></tr>
          ))}
        </tbody>
      </table>

      <div className="signature-section" style={{ marginTop: 30 }}>
        <div className="signature-box"><div className="signature-line">Receiver's Signature</div></div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ marginBottom: 5 }}>For <strong>Bavya Health Service Pvt. Ltd</strong></div>
          <div className="signature-box"><div className="signature-line">Authorised Signature</div></div>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 15, fontSize: 10, color: '#999' }}>
        <div>Prepared by ________________</div>
        <div>Checked by ________________</div>
      </div>
    </div>
  );
});

/* ─────────────────── SUPPLIER QUOTATION ─────────────────── */
export const SupplierQuotationPrint = React.forwardRef(({ data }, ref) => {
  if (!data) return null;
  const items = data.items || [];
  const total = items.reduce((s, i) => s + (parseFloat(i.quantity || 0) * parseFloat(i.rate || i.unit_price || 0)), 0);
  const totalQty = items.reduce((s, i) => s + parseFloat(i.quantity || 0), 0);
  const grandTotal = total;
  const roundedTotal = Math.round(grandTotal);

  return (
    <div ref={ref} className="print-document" style={{ position: 'relative' }}>
      <style>{printStyles}</style>
      {data.status === 'draft' && <div className="draft-watermark">DRAFT</div>}

      <div style={{ textAlign: 'center', marginBottom: 20 }}>
        <div style={{ fontSize: 24, fontWeight: 700, color: '#555' }}>SUPPLIER QUOTATION</div>
        <div style={{ fontSize: 12, color: '#999' }}>{data.quotation_number || ''}</div>
      </div>

      <div style={{ textAlign: 'center', fontSize: 16, fontWeight: 700, marginBottom: 15 }}>
        {data.status?.toUpperCase() || 'DRAFT'}
      </div>

      <div style={{ textAlign: 'center', marginBottom: 15 }}>
        <div><strong>Date:</strong> {formatDate(data.quotation_date || data.created_at)}</div>
        <div><strong>Valid Till:</strong> {formatDate(data.valid_till)}</div>
      </div>

      {data.vendor_name && (
        <div style={{ marginBottom: 15 }}>
          <div><strong>Supplier:</strong> {data.vendor_name}</div>
          {data.vendor_address && <div>{data.vendor_address}</div>}
          {data.vendor_gstin && <div>GSTIN: {data.vendor_gstin}</div>}
        </div>
      )}

      <table>
        <thead><tr>
          <th style={{ width: 50 }}>Sr</th>
          <th>Item</th>
          <th style={{ width: 80, textAlign: 'right' }}>Quantity</th>
          <th style={{ width: 90, textAlign: 'right' }}>Rate</th>
          <th style={{ width: 90, textAlign: 'right' }}>Amount</th>
        </tr></thead>
        <tbody>
          {items.map((item, i) => {
            const qty = parseFloat(item.quantity || 0);
            const rate = parseFloat(item.rate || item.unit_price || 0);
            return (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>{item.item_name || item.name || '-'}</td>
                <td style={{ textAlign: 'right' }}>{qty}</td>
                <td style={{ textAlign: 'right' }}>{formatCurrency(rate)}</td>
                <td style={{ textAlign: 'right' }}>{formatCurrency(qty * rate)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
        <div><strong>Total Quantity:</strong><br />{totalQty}</div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 20 }}><span><strong>Total</strong></span><span>{formatCurrency(total)}</span></div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 20, marginTop: 4 }}><span><strong>Grand Total:</strong></span><span>{formatCurrency(grandTotal)}</span></div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 20, marginTop: 4 }}><span><strong>Rounded Total:</strong></span><span>{formatCurrency(roundedTotal)}</span></div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 25 }}>
        <div><strong>Company Billing Address:</strong><br />{COMPANY.name}-Billing</div>
        <div style={{ textAlign: 'right' }}>
          <strong>Billing Address Details:</strong><br />
          {COMPANY.address.split(',').map((l, i) => <div key={i}>{l.trim()}</div>)}
          <div>State Code: {COMPANY.stateCode}</div>
          <div>GSTIN: {COMPANY.gstin}</div>
        </div>
      </div>

      <div className="signature-section">
        <div className="signature-box"><div className="signature-line">Authorized By</div></div>
      </div>
    </div>
  );
});

/* ─────────────────── MATERIAL INDENT ─────────────────── */
export const IndentPrint = React.forwardRef(({ data }, ref) => {
  if (!data) return null;
  const items = data.items || [];

  return (
    <div ref={ref} className="print-document" style={{ position: 'relative' }}>
      <style>{printStyles}</style>
      {data.status === 'draft' && <div className="draft-watermark">DRAFT</div>}

      <div className="doc-header">
        <div className="company-info">
          <div><strong>{COMPANY.name}</strong></div>
          <div>{COMPANY.address.split(',').slice(0, 2).join(', ')}</div>
          <div>{COMPANY.address.split(',').slice(2).join(', ')}</div>
          <div>{COMPANY.phone} | {COMPANY.email}</div>
        </div>
        <div>
          <div className="doc-title" style={{ color: '#1a4b8c' }}>MATERIAL INDENT</div>
          <div className="doc-subtitle">Date: <strong>{formatDate(data.indent_date || data.created_at)}</strong></div>
          <div className="doc-subtitle">Indent No: <strong>{data.indent_number || `Indent #${data.id}`}</strong></div>
        </div>
      </div>

      <div className="section-header" style={{ background: '#1a4b8c' }}>INDENT DETAILS</div>
      <div className="info-grid">
        <div className="info-row"><span className="info-label">PROJECT</span><span className="info-value">{data.project_name || data.project || '-'}</span></div>
        <div className="info-row"><span className="info-label">WAREHOUSE</span><span className="info-value">{data.warehouse_name || data.warehouse || '-'}</span></div>
        <div className="info-row"><span className="info-label">DEPARTMENT</span><span className="info-value">{data.department || data.department_name || '-'}</span></div>
        <div className="info-row"><span className="info-label">REQUIRED DATE</span><span className="info-value">{formatDate(data.required_date)}</span></div>
        <div className="info-row"><span className="info-label">INDENT TYPE</span><span className="info-value" style={{ textTransform: 'capitalize' }}>{data.indent_type || '-'}</span></div>
        <div className="info-row"><span className="info-label">STATUS</span><span className="info-value" style={{ textTransform: 'capitalize' }}>{(data.status || '').replace(/_/g, ' ')}</span></div>
        <div className="info-row"><span className="info-label">RAISED BY</span><span className="info-value">{data.created_by_name || data.requested_by_name || data.raised_by_name || '-'}</span></div>
        <div className="info-row"><span className="info-label">RAISING POSITION</span><span className="info-value">{data.position_name ? `${data.position_name} ${data.position_code ? `(${data.position_code})` : ''}` : '-'}</span></div>
        {data.vehicle_code && <div className="info-row"><span className="info-label">VEHICLE CODE</span><span className="info-value">{data.vehicle_code}</span></div>}
        {data.vehicle_number && <div className="info-row"><span className="info-label">VEHICLE NUMBER</span><span className="info-value">{data.vehicle_number}</span></div>}
        {data.service_code && <div className="info-row"><span className="info-label">SERVICE CODE</span><span className="info-value">{data.service_code}</span></div>}
        {data.source_bom_code && <div className="info-row"><span className="info-label">SOURCE BOM</span><span className="info-value">{data.source_bom_code}</span></div>}
      </div>

      <div className="section-header" style={{ background: '#1a4b8c' }}>ITEMS REQUESTED</div>
      <table>
        <thead>
          <tr>
            <th style={{ width: 40 }}>SNo</th>
            <th style={{ width: 120 }}>Item Code</th>
            <th>Item Name</th>
            <th style={{ width: 100, textAlign: 'right' }}>Requested Qty</th>
            <th style={{ width: 80 }}>UOM</th>
            <th style={{ width: 100, textAlign: 'right' }}>Approved Qty</th>
            <th>Remarks</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => (
            <tr key={i}>
              <td>{i + 1}</td>
              <td>{item.item_code || (item.item && item.item.item_code) || '-'}</td>
              <td>{item.item_name || (item.item && (item.item.item_name || item.item.name)) || '-'}</td>
              <td style={{ textAlign: 'right' }}>{item.requested_qty || item.qty || 0}</td>
              <td>{item.uom || item.unit || '-'}</td>
              <td style={{ textAlign: 'right' }}>{item.approved_qty != null ? item.approved_qty : '-'}</td>
              <td>{item.remarks || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {data.remarks && (
        <div style={{ marginTop: 12 }}>
          <div className="notes-label" style={{ color: '#1a4b8c' }}>Remarks:</div>
          <div className="notes-section">{data.remarks}</div>
        </div>
      )}

      <div className="signature-section">
        <div className="signature-box"><div className="signature-line">Prepared By</div></div>
        <div className="signature-box"><div className="signature-line">Approved By</div></div>
      </div>
    </div>
  );
});

PurchaseOrderPrint.displayName = 'PurchaseOrderPrint';
RFQPrint.displayName = 'RFQPrint';
PurchaseReceiptPrint.displayName = 'PurchaseReceiptPrint';
DeliveryChallanPrint.displayName = 'DeliveryChallanPrint';
SupplierQuotationPrint.displayName = 'SupplierQuotationPrint';
IndentPrint.displayName = 'IndentPrint';
